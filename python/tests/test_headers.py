from pi_mono.utils.headers import headers_to_record


def test_headers_to_record_dict():
    headers = {"Content-Type": "application/json", "Authorization": "Bearer token"}
    res = headers_to_record(headers)
    assert res == {"Content-Type": "application/json", "Authorization": "Bearer token"}


def test_headers_to_record_none():
    assert headers_to_record(None) == {}


class CustomHeaders:
    def __init__(self, data):
        self.data = data

    def items(self):
        return self.data.items()


def test_headers_to_record_custom_items():
    custom = CustomHeaders({"X-Custom": "value"})
    assert headers_to_record(custom) == {"X-Custom": "value"}


def test_headers_to_record_iterable():
    headers_list = [("Content-Type", "text/plain"), ("X-Test", "123")]
    res = headers_to_record(headers_list)
    assert res == {"Content-Type": "text/plain", "X-Test": "123"}
