import { processData } from "./utils";

async function main(): Promise<void> {
  console.log("starting app");
  const data = await fetch("/api/data");
  debugger;
  const result = processData(data);
  console.log("result:", result);
}

main();
