import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp({ config, logger: true });

try {
  await app.listen({ host: config.host, port: config.port });
  console.log(`航策 FlightGuard 已启动：http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
