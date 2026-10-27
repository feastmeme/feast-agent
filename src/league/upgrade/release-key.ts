/**
 * The release key's public half (task 975, run 23, rail a): `FL upgrade` checks a release's manifest signature with it,
 * and the opt-in auto-upgrade never runs without it. Ed25519, SPKI PEM, as the coordinator made it (run 26, amendment
 * G: generated outside any repository with `node tools/release-sign.mjs keygen --out <a folder outside the
 * repository>`). The private half never enters a repository; releases are signed at publish, never here.
 */
export const RELEASE_PUBLIC_KEY: string | null = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA3SYIcKpmwWNWhjwfAaev5tcCmEX0a9+6NSVL1aZkW9M=
-----END PUBLIC KEY-----
`;
