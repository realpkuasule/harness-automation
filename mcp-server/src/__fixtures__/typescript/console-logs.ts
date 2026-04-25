function processItems(items: unknown[]): void {
  console.log("processing items", items.length);
  for (const item of items) {
    console.debug("item:", item);
  }
}

function handleError(err: Error): void {
  console.error("error occurred", err.message);
  console.warn("retrying operation");
}
