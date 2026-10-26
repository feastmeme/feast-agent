/**
 * The release key's public half (task 975, run 23, rail a): `FL upgrade` checks a release's manifest signature with it,
 * and the opt-in auto-upgrade never runs without it. Null until the coordinator makes the key
 * (`node tools/release-sign.mjs keygen --out <a folder outside the repository>`) and pastes the printed public key
 * here, before the release that should carry it is tagged. The private half never enters a repository.
 */
export const RELEASE_PUBLIC_KEY: string | null = null;
