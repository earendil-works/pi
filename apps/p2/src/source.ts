// Resolve workspace packages to sources without depending on coding-agent.
// Dev tracking installs before application imports, including the server and worker entry graphs.
import "./hosts/dev-modules.ts";
import "./source-resolver.ts";
