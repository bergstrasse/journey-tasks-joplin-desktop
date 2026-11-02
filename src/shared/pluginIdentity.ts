import manifest from '../manifest.json';

/** Stable across releases and devices; never generate a namespace at startup. */
export const PLUGIN_ID = manifest.id;
export const LOCAL_SETTINGS_PREFIX = `${PLUGIN_ID}.`;
