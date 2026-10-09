// Add a dataset of questions to a chatbot: import a file, type a few, or start empty.
// The chatbot is always chosen explicitly (it decides where New run lists the set).
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Download, FileUp, ListPlus, Plus } from 'lucide-react'
import { useState } from 'react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { projectOption, useProjects } from '../lib/projects'
import type { Dataset } from '../lib/types'
import { Button, ErrorState, Field, Input, Segmented, Select, Textarea } from './ui'
import { FileInput, TextLink } from './form'
import { LabelHelp } from './LabelHelp'

type Mode = 'file' | 'type' | 'empty'

/** One question per line becomes a question with no expectations yet. */
export function questionsToCases(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((q, i) => ({
    id: `q_${String(i + 1).padStart(2, '0')}_${q.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'question'}`,
    title: q.slice(0, 120),
    input: { message: q },
    metadata: { provenance: { source: 'typed' } },
  }))
}

export function DatasetAdd({ projectId: fixedProject, defaultProjectId = '', onDone, compact = false }: {
  projectId?: number | ''
  defaultProjectId?: number | ''
  onDone?: (d: Dataset) => void
  compact?: boolean
}) {
  const qc = useQueryClient()
  const projects = useProjects()
  const [picked, setPicked] = useState<number | ''>(defaultProjectId)
  const projectId = fixedProject || picked
  const [mode, setMode] = useState<Mode>('file')
  const [file, setFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [name, setName] = useState('')
  const [typed, setTyped] = useState('')
  const done = (d: Dataset) => {
    qc.invalidateQueries({ queryKey: ['datasets'] })
    qc.invalidateQueries({ queryKey: ['home'] })
    setFile(null); setFileKey((k) => k + 1); setName(''); setTyped('')
    onDone?.(d)
  }
  const add = useMutation({
    mutationFn: async () => {
      if (mode === 'file') {
        const form = new FormData()
        form.set('project_id', String(projectId))
        if (name) form.set('name', name)
        form.set('file', file!)
        return api.upload<Dataset>('/api/datasets/import', form)
      }
      return api.post<Dataset>('/api/datasets', { project_id: projectId, name, cases: mode === 'type' ? questionsToCases(typed) : [] })
    },
    onSuccess: done,
  })
  const lines = typed.split('\n').filter((l) => l.trim()).length
  const ready = !!projectId && (mode === 'file' ? !!file : mode === 'type' ? lines > 0 && !!name.trim() : !!name.trim())
  const why = !projectId ? 'Choose the chatbot these questions are for.' : mode === 'file' && !file ? 'Choose a file.' : mode === 'type' && !lines ? 'Type at least one question.' : !ready ? 'Give the dataset a name.' : null

  return (
    <div className="space-y-3">
      {!fixedProject && (
        <Field label={<LabelHelp label="For which chatbot?"><p>New run lists a chatbot’s own datasets first.</p></LabelHelp>}>
          <Select value={projectId} onChange={(e) => setPicked(e.target.value ? Number(e.target.value) : '')} aria-label="Chatbot for the dataset">
            <option value="">Choose a chatbot…</option>
            {projects.visible.map((p) => <option key={p.id} value={p.id}>{projectOption(p)}</option>)}
          </Select>
        </Field>
      )}
      <Segmented size="sm" value={mode} onChange={setMode} label="How to add"
        options={[{ id: 'file', label: 'Import a file' }, { id: 'type', label: 'Type questions' }, { id: 'empty', label: 'Empty' }]} />
      {mode === 'file' && (
        <>
          <Field label={<LabelHelp label="JSON, YAML or CSV" title="File columns"><p>CSV columns can be plain words: <i>Question</i>, <i>Must mention</i>, <i>Must never say</i>, <i>Should refuse?</i>, <i>Correct answer</i>, <i>Topic</i>.</p></LabelHelp>}>
            <FileInput key={fileKey} accept=".json,.yaml,.yml,.csv" aria-label="Dataset file" onFiles={(f) => setFile(f[0] ?? null)} />
          </Field>
          <Input placeholder="Name (optional: the file’s own name otherwise)" value={name} onChange={(e) => setName(e.target.value)} aria-label="Dataset name" />
          {!compact && <TextLink href="/api/datasets/template.csv" size="sm"><Download className="size-3" />Spreadsheet template for colleagues (opens in Excel)</TextLink>}
        </>
      )}
      {mode === 'type' && (
        <>
          <Input placeholder="Name, e.g. First questions" value={name} onChange={(e) => setName(e.target.value)} aria-label="Dataset name" />
          <div className="text-xs font-medium text-ink-2"><LabelHelp label="Questions, one per line" title="Questions without expectations"><p>Each line becomes a question with no expectations yet: rule checks show “not applicable” until you add what a correct answer must say (open the dataset afterwards).</p></LabelHelp></div>
          <Textarea rows={5} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Questions, one per line"
            placeholder={'One question per line, the way users ask:\nWhich returns policy does X200 use?\nWhat does return code RMA-17 mean?'} />
        </>
      )}
      {mode === 'empty' && <Input placeholder="Name of the new, empty dataset" value={name} onChange={(e) => setName(e.target.value)} aria-label="Dataset name" />}
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={!ready} loading={add.isPending} onClick={() => add.mutate()}>
          {mode === 'file' ? <FileUp className="size-3.5" /> : mode === 'type' ? <ListPlus className="size-3.5" /> : <Plus className="size-3.5" />}
          {mode === 'file' ? 'Import' : mode === 'type' ? (lines ? `Add ${plural(lines, 'question')}` : 'Add questions') : 'Add dataset'}
        </Button>
        {why && <span className="text-xs text-ink-2">{why}</span>}
      </div>
      {add.isError && <ErrorState error={add.error} />}
    </div>
  )
}
