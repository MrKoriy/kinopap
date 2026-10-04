#!/usr/bin/env python3
"""Держит дисковый кэш TorrServer в пределах TS_CACHE_MAX_GB (по умолчанию 25).
Первыми уходят раздачи, к которым дольше всех не обращались (mtime).
Прогрев голов топ-N (apps/worker, stream-headwarm) сам не вытесняет — он
останавливается у 90% потолка и обновляет mtime каталогов горячих раздач,
чтобы LRU здесь убирал холодное, а не только что прогретое."""
import os, shutil

root = os.environ.get("TS_CACHE_DIR", "/opt/kinopap/data/ts-cache")
limit = float(os.environ.get("TS_CACHE_MAX_GB", "25")) * 1024 ** 3


def size(p):
    if os.path.isfile(p):
        return os.path.getsize(p)
    n = 0
    for d, _, fs in os.walk(p):
        for f in fs:
            try:
                n += os.path.getsize(os.path.join(d, f))
            except OSError:
                pass
    return n


if os.path.isdir(root):
    entries = [os.path.join(root, e) for e in os.listdir(root)]
    sized = sorted(((os.path.getmtime(e), size(e), e) for e in entries))
    total = sum(s for _, s, _ in sized)
    for _, s, e in sized:
        if total <= limit:
            break
        if os.path.isdir(e):
            shutil.rmtree(e, ignore_errors=True)
        else:
            os.remove(e)
        total -= s
        print(f"ts-cache: убрано {os.path.basename(e)} ({s // 1048576} MiB)")
