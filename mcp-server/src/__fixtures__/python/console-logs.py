def process_items(items: list) -> None:
    print("processing items", len(items))
    for item in items:
        print("item:", item)

def handle_error(err: Exception) -> None:
    print("error occurred", str(err))
    print("retrying operation")
