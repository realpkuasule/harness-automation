def add(a: int, b: int) -> int:
    return a + b

MAX_RETRIES = 3

def fetch_data(url: str) -> dict:
    try:
        import requests
        response = requests.get(url)
        return response.json()
    except Exception as err:
        print("fetch failed", err)
        raise
