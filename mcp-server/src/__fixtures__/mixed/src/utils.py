def process_data(data: dict) -> dict:
    print("processing data")
    items = data.get("items", [])
    result = {"count": len(items), "items": items}
    return result
