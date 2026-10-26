/**
 * `pnpm dev`: the API with the fake login on, so a tester needs no secrets.
 *
 * A launcher rather than `MIDES_DEV_LOGIN=1 node ...` in package.json, because
 * that syntax does not exist in cmd.exe. A value in `.env` wins: set
 * MIDES_DEV_LOGIN=0 there to try the real Mides SSO in development.
 */
process.env.MIDES_DEV_LOGIN ??= '1';

await import('./index.js');
