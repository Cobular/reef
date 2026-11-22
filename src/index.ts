import { githubApi } from "./auth/github";
import { createWorker } from "./worker";

export default createWorker({ github: githubApi });
