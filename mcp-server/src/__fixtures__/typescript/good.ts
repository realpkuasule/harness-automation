function add(a: number, b: number): number {
  return a + b;
}

const MAX_RETRIES = 3;

async function fetchData(url: string): Promise<unknown> {
  try {
    const response = await fetch(url);
    return response.json();
  } catch (err) {
    console.error("fetch failed", err);
    throw err;
  }
}

export { add, MAX_RETRIES, fetchData };
