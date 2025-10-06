export async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R | null>
): Promise<R | null> {
  return new Promise((resolve) => {
    let i = 0,
      active = 0,
      done = false;

    const next = () => {
      if (done) return;
      if (i >= items.length && active === 0) return resolve(null);
      while (active < limit && i < items.length) {
        const idx = i++;
        active++;
        worker(items[idx])
          .then((res) => {
            active--;
            if (!done && res) {
              done = true;
              resolve(res);
            } else {
              next();
            }
          })
          .catch(() => {
            active--;
            next();
          });
      }
    };

    next();
  });
}
