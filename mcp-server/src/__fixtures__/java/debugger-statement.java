public class DebuggerExample {
    public int complexCalculation(int a, int b) {
        debugger;
        int result = a * b + a / b;
        return result;
    }

    public void findBug() {
        int x = 42;
        debugger;
        System.out.println("checking value " + x);
    }
}
