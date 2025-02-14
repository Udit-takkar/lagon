import { getBytesFromReply, getBytesFromRequest, getDeploymentFromRequest } from 'src/deployments/utils';
import { addDeploymentResult, getCpuTime } from 'src/deployments/result';
import Fastify from 'fastify';
import {
  DeploymentResult,
  HandlerRequest,
  addLog,
  OnDeploymentLog,
  DeploymentLog,
  getIsolate,
  OnReceiveStream,
} from '@lagon/runtime';
import { getAssetContent, getDeploymentCode } from 'src/deployments';
import path from 'node:path';
import fs from 'node:fs';
import type { Isolate } from 'isolated-vm';
import { extensionToContentType } from '@lagon/common';
import { IS_DEV } from './constants';
import { Readable } from 'node:stream';
import { TextDecoder } from 'node:util';

const fastify = Fastify({
  logger: false,
});

fastify.addContentTypeParser('multipart/form-data', (request, payload, done) => {
  let data = '';

  payload.on('data', chunk => {
    data += chunk;
  });

  payload.on('end', () => {
    done(null, data);
  });
});

const html404 = fs.readFileSync(path.join(new URL('.', import.meta.url).pathname, '../public/404.html'), 'utf8');
const html500 = fs.readFileSync(path.join(new URL('.', import.meta.url).pathname, '../public/500.html'), 'utf8');

const streams = new Map<string, Readable>();

const onReceiveStream: OnReceiveStream = (deployment, done, chunk) => {
  let stream = streams.get(deployment.deploymentId);

  if (!stream) {
    stream = new Readable();
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    stream._read = () => {};
    streams.set(deployment.deploymentId, stream);
  }

  stream.push(done ? null : chunk);
};

const logs = new Map<string, DeploymentLog[]>();

const onDeploymentLog: OnDeploymentLog = ({ deploymentId, log }) => {
  if (!logs.has(deploymentId)) {
    logs.set(deploymentId, []);
  }

  logs.get(deploymentId)?.push(log);
};

function getStackTrace(error: Error) {
  const stack = error.stack?.split('\n');

  if (stack) {
    return stack
      .filter(line => {
        return !(line.includes('file://') || line.includes('at masterHandler') || line.includes('.ts:'));
      })
      .join('\n');
  }

  return error.message;
}

export default function startServer(port: number, host: string) {
  fastify.all('/*', async (request, reply) => {
    const id = `Request ${Math.random()}`;

    if (IS_DEV) console.time(id);

    const deployment = getDeploymentFromRequest(request);

    if (!deployment) {
      reply.status(404).header('Content-Type', 'text/html').send(html404);

      if (IS_DEV) console.timeEnd(id);
      return;
    }

    const asset = deployment.assets.find(asset => request.url === `/${asset}`);

    if (asset) {
      const extension = path.extname(asset);

      reply
        .status(200)
        .header('Content-Type', extensionToContentType(extension) || 'text/plain')
        .send(getAssetContent(deployment, asset));

      if (IS_DEV) console.timeEnd(id);
      return;
    }

    if (request.url === '/favicon.ico') {
      reply.code(204);

      if (IS_DEV) console.timeEnd(id);
      return;
    }

    const deploymentResult: DeploymentResult = {
      cpuTime: BigInt(0),
      receivedBytes: getBytesFromRequest(request),
      sentBytes: 0,
      logs: [],
    };

    let isolateCache: Isolate | undefined = undefined;
    let errored = false;

    try {
      const runIsolate = await getIsolate({
        deployment,
        getDeploymentCode,
        onReceiveStream,
        onDeploymentLog,
      });

      const handlerRequest: HandlerRequest = {
        input: request.protocol + '://' + request.hostname + request.url,
        options: {
          method: request.method,
          headers: request.headers,
          body: typeof request.body === 'object' ? JSON.stringify(request.body) : String(request.body),
        },
      };

      const { response, isolate } = await runIsolate(handlerRequest);
      isolateCache = isolate;

      if (!response) {
        throw new Error('Function did not return a response');
      }

      const headers: Record<string, string> = {};

      // @ts-expect-error we access `headers` which is the private map inside `Headers`
      for (const [key, values] of response.headers.headers.entries()) {
        if (values[0] instanceof Map) {
          for (const [key, value] of values[0]) {
            headers[key] = value;
          }
        }

        headers[key] = values[0];
      }

      let payload = streams.get(deployment.deploymentId) || response.body;

      if (payload instanceof Readable) {
        payload.on('end', () => {
          streams.delete(deployment.deploymentId);
        });
      } else if (payload instanceof Uint8Array) {
        payload = new TextDecoder().decode(payload);
      }

      reply
        .status(response.status || 200)
        .headers(headers)
        .send(payload);

      if (IS_DEV) console.timeEnd(id);

      deploymentResult.sentBytes = getBytesFromReply(reply);
    } catch (error) {
      errored = true;

      reply.status(500).header('Content-Type', 'text/html').send(html500);
      if (IS_DEV) console.timeEnd(id);

      console.log(
        `An error occured while running the function: ${(error as Error).message}: ${(error as Error).stack}`,
      );

      addLog({ deploymentId: deployment.deploymentId, logLevel: 'error', onDeploymentLog })(
        getStackTrace(error as Error),
      );
    }

    if (!errored && isolateCache !== undefined) {
      deploymentResult.cpuTime = getCpuTime({ isolate: isolateCache, deployment });
    }

    deploymentResult.logs = logs.get(deployment.deploymentId) || [];

    logs.delete(deployment.deploymentId);

    addDeploymentResult({ deployment, deploymentResult });
  });

  fastify.listen(port, host, (err, address) => {
    if (err) {
      console.error(err);
      process.exit(1);
    }

    console.log(`Lagon is listening on ${address}`);
  });
}
