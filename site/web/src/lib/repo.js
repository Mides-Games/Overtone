/** The public repository, where the docs a page cites can be read. */
export const REPO_URL = 'https://github.com/Mides-Games/Overtone'

/**
 * A file of the repository on GitHub, for a page that cites where something
 * is written (W12.12). Only a plain relative path is accepted, so a locale
 * string can never turn this into a link somewhere else.
 */
export const repoFile = (path) =>
  /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) && !path.split('/').includes('..') ? `${REPO_URL}/blob/master/${path}` : null
