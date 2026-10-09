// "Share": a run or a comparison as a report someone else can read - Markdown (download or copy),
// a printable page (Print / Save as PDF), or the full JSON.
import { ChevronDown, ClipboardCopy, FileDown, FileJson, Printer, Share2 } from 'lucide-react'
import { Menu, MenuItem } from './form'
import { Button, toast } from './ui'

function download(href: string, name?: string) {
  const a = document.createElement('a')
  a.href = href
  if (name) a.download = name
  a.click()
}

export function ShareMenu({ runId, baselineId }: { runId: number; baselineId?: number | null }) {
  const against = baselineId ? `&baseline=${baselineId}` : ''
  const md = `/api/runs/${runId}/export?format=md${against}`
  const copy = async () => {
    try {
      const text = await (await fetch(md)).text()
      await navigator.clipboard.writeText(text)
      toast('Copied as Markdown', 'good')
    } catch {
      toast('Could not copy: the browser refused', 'bad')
    }
  }
  return (
    <Menu align="right" width={256}
      trigger={({ open, props }) => <Button {...props} aria-expanded={open}><Share2 className="size-3.5" />Share<ChevronDown className="size-3" /></Button>}>
      <MenuItem icon={<FileDown className="size-4" />} onClick={() => download(md, `assay-${baselineId ? `${baselineId}-vs-` : ''}${runId}.md`)}>Markdown report</MenuItem>
      <MenuItem icon={<ClipboardCopy className="size-4" />} onClick={copy}>Copy as Markdown</MenuItem>
      <MenuItem icon={<Printer className="size-4" />} onClick={() => setTimeout(() => window.print(), 50)}>Print / save as PDF</MenuItem>
      <MenuItem icon={<FileJson className="size-4" />} onClick={() => download(`/api/runs/${runId}/export?format=json${against}`)}>Full JSON</MenuItem>
    </Menu>
  )
}
