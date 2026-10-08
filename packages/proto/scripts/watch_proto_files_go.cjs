// This package does not generate Go. The old watcher pointed at another repo's
// core/ and protocol/ trees. Do not watch those paths and do not run go generate.
console.error('watch:go is not part of this repo. There is no Go generate step here.')

process.exit(0)
