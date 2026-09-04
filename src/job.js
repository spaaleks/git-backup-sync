import { GitRegistry } from './mirror.js';
import { Redactor, rootRedactor, child } from './logger.js';

export class Job {
  #controller = new AbortController();

  constructor({ reason = 'scheduled', secrets = [] } = {}) {
    this.reason = reason;
    this.git = new GitRegistry();
    this.redactor = new Redactor(rootRedactor);
    for (const secret of secrets) this.redactor.add(secret);
  }

  get signal() {
    return this.#controller.signal;
  }

  get stopping() {
    return this.#controller.signal.aborted;
  }

  get runningGit() {
    return this.git.size;
  }

  stop(reason = 'stop requested') {
    this.#controller.abort(reason);
  }

  killGit(signal) {
    return this.git.killAll(signal);
  }

  log(context) {
    return child(context, this.redactor);
  }
}
