import { resolve } from 'node:path';
import { createApp } from './app.js';
const app=await createApp({dataDir:resolve(process.env.ALBUM_RELAY_DATA_DIR??'./data')});
const port=Number(process.env.PORT??3210);
await app.listen({host:process.env.ALBUM_RELAY_HOST??'0.0.0.0',port});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().finally(()=>process.exit(0));});
