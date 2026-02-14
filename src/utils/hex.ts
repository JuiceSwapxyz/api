export const prefix0x = (hash: string) =>
  hash.startsWith("0x") ? hash : `0x${hash}`;

export const unprefix0x = (hash: string) =>
  hash.startsWith("0x") ? hash.slice(2) : hash;
