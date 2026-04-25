public class Good {
    public int add(int a, int b) {
        return a + b;
    }

    public static final int MAX_RETRIES = 3;

    public String fetchData(String url) {
        try {
            var response = fetch(url);
            return response.toString();
        } catch (Exception e) {
            System.out.println("fetch failed");
            throw e;
        }
    }

    private Object fetch(String url) {
        return null;
    }
}
