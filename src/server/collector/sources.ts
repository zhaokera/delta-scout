import { jiaoyimaoAdapter } from "./adapters/jiaoyimao.js";
import { panzhiAdapter } from "./adapters/panzhi.js";
import { pxb7Adapter } from "./adapters/pxb7.js";
import type { SourceAdapter } from "./types.js";

export const sourceAdapters: SourceAdapter[] = [
  jiaoyimaoAdapter,
  panzhiAdapter,
  pxb7Adapter
];
