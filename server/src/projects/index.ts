// The .devwebui schema (ID_RE / ProcessSchema / DevWebUIFileSchema / DevWebUIProcess)
// is the single source of truth in ../../shared/schema; re-export the inferred type
// so existing `import { DevWebUIProcess } from "./projects"` call sites keep working.
export type { DevWebUIProcess } from "../../../shared/schema";

export {
  projectIdFromPath,
  readDevWebUIFile,
  addProcessToFile,
  updateProcessInFile,
  removeProcessFromFile,
  setProcessStarred,
  readRegistry,
  registryAdd,
  registryRemove,
  readIgnoredProjects,
  ignoreProject,
  unignoreProject,
} from "./file-store";

export { browseForDevWebUIFile, browseForFolder } from "./native-dialogs";

export type { LoadTarget } from "./load-target";
export { resolveLoadTarget, scaffoldDevWebUIFile } from "./load-target";

export { looksLikeGitUrl, suggestCloneDest, cloneRepo } from "./git-clone";
