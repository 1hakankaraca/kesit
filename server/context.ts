import type { Server as IOServer } from 'socket.io';
import type { Store } from './db/Store.ts';
import type { ArchiveLedger } from './services/ArchiveLedger.ts';
import type { Autopilot } from './services/Autopilot.ts';
import type { Captions } from './services/Captions.ts';
import type { ClipHarvester } from './services/ClipHarvester.ts';
import type { Exporter } from './services/Exporter.ts';
import type { KickChat } from './services/KickChat.ts';
import type { Storage } from './services/Storage.ts';
import type { Projects } from './services/Projects.ts';
import type { Publishing } from './services/Publishing.ts';
import type { Snippets } from './services/Snippets.ts';
import type { SystemMonitor } from './services/SystemMonitor.ts';
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
  exporter: Exporter;
  storage: Storage;
  kickChat: KickChat;
  harvester: ClipHarvester;
  projects: Projects;
  system: SystemMonitor;
  snippets: Snippets;
}
