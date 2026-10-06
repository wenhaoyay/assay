def make_case(**kw):
    from gaugelab.datasets import validate_cases

    base = {"id": kw.pop("id", "c1"), "input": {"message": kw.pop("message", "hello")}}
    base.update(kw)
    return validate_cases([base])[0]
