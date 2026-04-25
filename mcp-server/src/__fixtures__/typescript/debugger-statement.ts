function complexCalculation(a: number, b: number): number {
  debugger;
  const result = a * b + a / b;
  debugger;
  return result;
}

function findBug(): void {
  const x = 42;
  debugger;
  console.log("checking value", x);
}
