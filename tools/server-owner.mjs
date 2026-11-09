// POSIX owner: descendants share the owner's process group, including when
// the OpenCode launcher exits. EOF also runs when the Host dies abruptly.
import { spawn } from 'node:child_process'
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: ['ignore', 'inherit', 'inherit'] })
const stop = () => { try { process.kill(-process.pid, 'SIGKILL') } catch { process.exit(1) } }
child.on('error', stop)
process.stdin.resume()
process.stdin.on('end', stop)
process.on('SIGTERM', stop)
