import "../../credentials/__fixtures__/host-os.mjs";
// Match this suite's macOS resolver boundary on every supported POSIX CI host.
Object.defineProperty(process, "platform", { ...Object.getOwnPropertyDescriptor(process, "platform"), value: "darwin" });
