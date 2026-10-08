/**
 * Metrics in Prometheus text format (B-10) without dependencies. Labels come only from small
 * fixed sets: bot name, instrument slot, role. Party and amounts never.
 */
type Labels = Record<string, string>

const key = (labels: Labels) =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]!.replace(/["\\\n]/g, '_')}"`)
    .join(',')

export function createMetrics() {
  const series = new Map<
    string,
    { help: string; type: 'gauge' | 'counter'; values: Map<string, number> }
  >()
  const family = (name: string, help: string, type: 'gauge' | 'counter') => {
    let f = series.get(name)
    if (!f) {
      f = { help, type, values: new Map() }
      series.set(name, f)
    }
    return f
  }
  return {
    gauge(name: string, help: string, value: number, labels: Labels = {}) {
      family(name, help, 'gauge').values.set(key(labels), value)
    },
    inc(name: string, help: string, labels: Labels = {}, by = 1) {
      const f = family(name, help, 'counter')
      const k = key(labels)
      f.values.set(k, (f.values.get(k) ?? 0) + by)
    },
    get(name: string, labels: Labels = {}): number | undefined {
      return series.get(name)?.values.get(key(labels))
    },
    render(): string {
      const out: string[] = []
      for (const [name, f] of series) {
        out.push(`# HELP ${name} ${f.help}`, `# TYPE ${name} ${f.type}`)
        for (const [k, v] of f.values) out.push(`${name}${k ? `{${k}}` : ''} ${v}`)
      }
      return `${out.join('\n')}\n`
    },
  }
}

export type Metrics = ReturnType<typeof createMetrics>
