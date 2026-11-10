// Port wiring: fakes for dry runs (--fake), real adapters otherwise.

import { fakePorts } from "./fakes";
import { RealLab } from "./lab";
import type { Host, Ports } from "./ports";
import { SshEnv } from "./ssh-env";
import { validateCR } from "./validate";

export function makePorts(host: Host, fake: boolean): Ports {
  return fake ? fakePorts() : { kind: "real", env: new SshEnv(host), lab: new RealLab(host), validate: validateCR };
}
