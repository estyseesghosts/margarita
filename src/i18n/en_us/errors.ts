import type { ErrorsStrings } from '../types.ts';

/** English (United States) pairing validation and inspector metadata headings. */
export const errorsEnUs = {
  pairing: {
    invalidUrl: 'Invalid pairing URL.',
    httpOnly: 'Pairing URLs must use http or https.',
    embeddedCredentials: 'Pairing URLs cannot contain embedded credentials.',
    queryOrFragment: 'A pairing URL cannot contain a query string or fragment.',
    missingConnectSuffix: 'A pairing URL must end with /auth/connect/<code>.',
    missingCode: 'The pairing URL is missing its one-time code.',
    usageShortname: 'Usage: /pair <url> [--as <shortname>]',
    usageUrl: 'Usage: /pair --url <url> [--as <name>]',
    onlyOneUrl: 'Only one pairing URL can be given.',
    unknownOption: (option) => `Unknown /pair option: ${option}`,
    usageFull:
      'Usage: /pair <https://host/auth/connect/code> [--as <shortname>], or /pair --url <https://host> --as <shortname>',
    manualNeedsShortname:
      'A manual server URL needs a shortname: /pair --url <https://host> --as <shortname>',
    invalidServerUrl: 'Invalid server URL.',
    serverHttpOnly: 'Server URLs must use http or https.',
    serverEmbeddedCredentials: 'Server URLs cannot contain embedded credentials.',
    serverQueryOrFragment: 'A server URL cannot contain a query string or fragment.',
  },
  inspector: {
    scriptFailed: 'script failed:',
    files: (count) => `files (${count}):`,
  },
  profile: {
    shortname:
      'A shortname must be 1-32 lowercase letters, digits, or single dashes, and cannot start or end with a dash.',
    invalidUrl: 'Invalid server URL.',
    unsupportedProtocol: (protocol) => `Unsupported URL protocol "${protocol}"; use http or https.`,
    credentials: 'Do not put credentials in a server URL.',
    fragment: 'A server URL cannot contain a fragment.',
    needsIdentity: 'A server needs an identity.',
    localReserved: 'The local server is reserved and cannot be paired as a remote.',
    shortnameInUse: (name) => `The shortname "${name}" is already in use.`,
    alreadyRegistered: 'That server address is already registered.',
    noProfile: (serverID) => `No server profile ${serverID}.`,
    unreadable: (detail) => `Could not read paired servers: ${detail}`,
    unreadablePreserved: (backup, detail) =>
      `Paired servers were unreadable; the original was preserved at ${backup}. ${detail}`,
    unreadablePreservedShort: (backup) =>
      `Paired servers were unreadable; the original was preserved at ${backup}.`,
    malformed: (path) =>
      `Paired servers file ${path} is malformed and was left untouched; paired servers are unavailable until it is repaired.`,
    skipped: (count, path) =>
      `${count} paired server record(s) in ${path} could not be read and were skipped; a backup is kept before the file is rewritten.`,
  },
} satisfies ErrorsStrings;
