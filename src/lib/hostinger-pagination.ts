export interface HostingerPage<T> {
  items: T[]
  totalPages: number | null
}

export async function collectHostingerPages<T>(
  loadPage: (page: number) => Promise<HostingerPage<T>>,
  perPage = 100,
): Promise<T[]> {
  const items: T[] = []

  for (let page = 1; ; page += 1) {
    const result = await loadPage(page)
    items.push(...result.items)
    if (result.totalPages !== null ? page >= result.totalPages : result.items.length < perPage) break
  }

  return items
}
