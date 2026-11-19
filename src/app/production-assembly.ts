import { join } from 'node:path';
import process from 'node:process';

import type { Backend } from '../adapter/backend.ts';
import type { Connection } from '../adapter/connection.ts';
import { ServerConnectionManager } from '../adapter/server-manager.ts';
import type { AppConfig } from '../config/config.ts';
import type { CredentialStore } from '../config/credentials.ts';
import { fileGoalStore, type GoalStore } from '../config/goal-store.ts';
import { type LocalState, type SaveResult, saveState } from '../config/local-state.ts';
import {
  removeProfile,
  renameProfile,
  saveServerProfiles,
  type ServerProfiles,
} from '../config/server-profiles.ts';
import { AppController, errorText, type ServerAdmin, type ServerListing } from './controller.ts';
import { type DebugLog, noDebugLog } from './debug-log.ts';
import { pairServer } from './pairing-service.ts';
import { listProjectFiles } from './project-files.ts';

export type AppPaths = Readonly<{
  stateFile: string;
  serversFile: string;
  stateDir: string;
}>;

/** One already-connected server to register before anything else happens. */
export type AssemblyConnection = Readonly<{
  serverID: string;
  label?: string;
  connection: Connection;
  backend: Backend;
  remoteFilesystem?: boolean;
}>;

/**
 * Everything the production controller needs. Callers pre-load files (config, profiles,
 * local state) and pick credentials; the assembly performs the wiring main.ts used to do
 * inline, so tests can drive the exact same composition with fake backends.
 */
export type ProductionAssemblyInput = Readonly<{
  config: AppConfig;
  platform: NodeJS.Platform;
  cwd: string;
  version: string;
  paths: AppPaths;
  env: NodeJS.ProcessEnv;
  credentials: CredentialStore;
  /** The launch connection(s), already connected and verified by the caller. */
  connections: readonly AssemblyConnection[];
  profiles: ServerProfiles;
  localState: LocalState;
  /** True only for the directly configured launch connection; paired servers get their own. */
  remoteFilesystem?: boolean;
  now?: () => number;
  goalStore?: GoalStore;
  debugLog?: DebugLog;
  /** Test hooks; production callers leave these unset. */
  listFiles?: (root: string) => Promise<string[]>;
  saveLocalState?: (state: LocalState) => Promise<SaveResult | void>;
  requestExit: () => void;
}>;

export type ProductionAssembly = Readonly<{
  servers: ServerConnectionManager;
  controller: AppController;
}>;

/**
 * Wires the server manager, credentials and profile store to the app controller exactly
 * as the real binary does. Used by `main.ts` and by production-composition tests, so the
 * missing-resolver class of bug cannot slip back in between the two.
 */
export function createProductionAssembly(input: ProductionAssemblyInput): ProductionAssembly {
  const launch = input.connections[0];
  if (launch === undefined)
    throw new Error('The production assembly needs at least one connection.');
  const launchServerID = launch.serverID;
  const launchBackend = launch.backend;
  const servers = new ServerConnectionManager();
  for (const registration of input.connections) {
    servers.add({
      serverID: registration.serverID,
      ...(registration.label === undefined ? {} : { label: registration.label }),
      connection: registration.connection,
      backend: registration.backend,
      remoteFilesystem:
        registration.remoteFilesystem ?? registration.connection.origin === 'remote',
    });
    servers.setState(registration.serverID, 'online');
  }
  const debugLog = input.debugLog ?? noDebugLog;
  let profiles = input.profiles;

  const saveAndKeep = async (next: ServerProfiles): Promise<ServerProfiles> => {
    const saved = await saveServerProfiles(input.paths.serversFile, next);
    profiles = saved;
    return saved;
  };

  const serversListing = (): ServerListing[] =>
    servers.list().map((entry) => ({
      serverID: entry.serverID,
      label: entry.label,
      baseUrl: entry.backend.baseUrl,
      state: entry.state,
      active: entry.serverID === launchServerID,
    }));

  const serverAdmin: ServerAdmin = {
    list: () => serversListing(),
    rename: async (targetID, label) => {
      const renamed = renameProfile(profiles.profiles, targetID, label);
      const saved = await saveAndKeep({ schemaVersion: 1, profiles: renamed });
      servers.setLabel(targetID, label);
      return saved.profiles.map((profile) => ({
        serverID: profile.serverID,
        label: profile.shortname,
        baseUrl: profile.baseUrl,
        state: servers.get(profile.serverID)?.state ?? 'offline',
        active: profile.serverID === launchServerID,
      }));
    },
    unpair: async (targetID) => {
      await saveAndKeep({
        schemaVersion: 1,
        profiles: removeProfile(profiles.profiles, targetID),
      });
      await input.credentials.delete(targetID).catch((error: unknown) => {
        process.stderr.write(
          `marg: could not remove the saved credential for ${targetID}: ${errorText(error)}\n`,
        );
      });
      await servers.remove(targetID);
    },
  };

  const controller = new AppController({
    backend: launchBackend,
    serverID: launchServerID,
    config: input.config,
    localState: input.localState,
    platform: input.platform,
    cwd: input.cwd,
    version: input.version,
    now: input.now ?? Date.now,
    saveLocalState: (state) =>
      input.saveLocalState === undefined
        ? saveState(input.paths.stateFile, state)
        : input.saveLocalState(state),
    listFiles: (root) =>
      input.listFiles === undefined ? listProjectFiles(root) : input.listFiles(root),
    ...(input.remoteFilesystem === undefined ? {} : { remoteFilesystem: input.remoteFilesystem }),
    requestExit: input.requestExit,
    goalStore:
      input.goalStore ??
      fileGoalStore(join(input.paths.stateDir, 'goals'), () => new Date().toISOString()),
    pair: async (request) => {
      const result = await pairServer(request, {
        servers,
        profiles: () => profiles,
        saveProfiles: saveAndKeep,
        credentials: input.credentials,
        ...(input.env['MARGARITA_SERVER_PASSWORD'] === undefined
          ? {}
          : { password: input.env['MARGARITA_SERVER_PASSWORD'] }),
        ...(input.env['MARGARITA_ALLOW_INSECURE_HTTP'] === '1' ? { allowInsecureHttp: true } : {}),
        toolOutputChars: input.config.transcript.toolOutputChars,
      });
      return { shortname: result.shortname };
    },
    serverAdmin,
    /** Production wiring: the manager's fail-closed resolver, never a silent fallback. */
    backendFor: (serverID) => servers.backendFor(serverID),
    serverIDs: () => servers.list().map((managed) => managed.serverID),
    serverInfo: (targetID) => {
      const managed = servers.get(targetID);
      if (managed === undefined) return undefined;
      return { label: managed.label, online: managed.state === 'online' };
    },
    debugLog,
  });

  return { servers, controller };
}
