// Register the plus module-redirect hooks. Load before the app via:
//   node --import <repo>/packages/plus/loader/register.mjs
// or NODE_OPTIONS="--import <repo>/packages/plus/loader/register.mjs".
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
