import type { Server as IOServer } from 'socket.io';
import type { Store } from './db/Store.ts';
import type { ArchiveLedger } from './services/ArchiveLedger.ts';
import type { Autopilot } from './services/Autopilot.ts';
import type { Captions } from './services/Captions.ts';
import type { Publishing } from './services/Publishing.ts';
import type { Workspaces } from './services/Workspaces.ts';

/** Rotaların ortak bağımlılıkları — server/index.ts bir kez kurar. */
export interface AppContext {
  store: Store;
  io: IOServer;
  workspaces: Workspaces;
  vodScanner: any;
  autopilot: Autopilot;
  archive: ArchiveLedger;
  publishing: Publishing;
  captions: Captions;
}
