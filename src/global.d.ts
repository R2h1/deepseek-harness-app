/**
 * Ambient declarations for modules the electrobun package imports in its
 * shipped TypeScript source but that carry no bundled types in this install
 * (`three`, `@babylonjs/core`). Our code never imports them directly.
 */
declare module "three";
declare module "@babylonjs/core";
