import { useState } from 'react'
import { plainError } from '../../lib/moderation/plainWords'
import type { CleaningGroup, DataSource } from '../../lib/data/types'
import { Reveal, Swap, useLingeringList } from '../Reveal'

export interface GroupsPanelProps {
  data: DataSource
  groups: CleaningGroup[]
  /**
   * A first load has finished. Until then "no groups" would be a guess; after
   * it, a reload leaves what is on screen alone rather than flickering it.
   */
  loaded: boolean
  error: string | null
  signedIn: boolean
  selectedId: string | null
  onSelect: (group: CleaningGroup) => void
  /** Something changed -- somebody joined, left or deleted -- so reload. */
  onChanged: () => void
  /** Whether a group can be started here. Not on a map with no database behind it. */
  canStart?: boolean
  /** An admin may delete any group, including one whose founder has gone. */
  isAdmin?: boolean
  /** There are more groups here than the list holds. */
  more?: boolean
}

const people = (count: number) => (count === 1 ? '1 person' : `${count} people`)

/**
 * The cleaning groups whose home is in view.
 *
 * Only ever a count of who is in each, never names: a member list is a list of
 * people who are in one place at predictable times.
 */
export function GroupsPanel({
  data,
  groups,
  loaded,
  error,
  signedIn,
  selectedId,
  onSelect,
  onChanged,
  canStart = true,
  isAdmin = false,
  more = false,
}: GroupsPanelProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [problem, setProblem] = useState<{ id: string; message: string } | null>(null)
  const [reported, setReported] = useState<Set<string>>(new Set())
  // Deleting takes everybody out of the group and cannot be undone, so it is
  // asked twice. One misclick must not wipe out a group other people joined.
  const [confirming, setConfirming] = useState<string | null>(null)
  const shown = useLingeringList(groups, (group) => group.id)

  const act = async (group: CleaningGroup, work: () => Promise<void>) => {
    setBusy(group.id)
    setProblem(null)
    try {
      await work()
      onChanged()
    } catch (cause) {
      setProblem({ id: group.id, message: plainError(cause instanceof Error ? cause.message : null) })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Cleaning groups" className="mo-glass rounded-2xl p-3">
      <h2 className="text-sm font-semibold text-slate-900">Cleaning groups here</h2>
      <p className="mt-1 text-xs text-slate-600">
        {canStart
          ? 'People who clean up an area together. Join one, or start one where you are looking.'
          : 'People who clean up an area together.'}
      </p>

      <Reveal show={!!(error)}>{(error) && (
        <p role="alert" className="mt-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-900">
          {error} Some groups may be missing.
        </p>
      )}</Reveal>

      <Reveal show={!!(loaded && !error && groups.length === 0)}>{(loaded && !error && groups.length === 0) && (
        <p role="status" className="mt-3 text-sm text-slate-600">
          {canStart ? 'No groups here yet. Move the map, or start the first one.' : 'No groups here yet.'}
        </p>
      )}</Reveal>

      <Reveal show={more}>
        <p role="status" className="mt-2 rounded-lg bg-slate-100 p-2 text-xs text-slate-700">
          Not every group here is shown. Zoom in to see the rest.
        </p>
      </Reveal>

      <ul className="mt-1 max-h-[40vh] overflow-auto">
        {shown.map(({ item: group, key, leaving }) => {
          const selected = group.id === selectedId
          return (
            <li key={key}>
              {/* Each card fades in as the map finds it, and out as the map
                  leaves it or it is deleted, rather than popping. */}
              <Reveal show={!leaving} gap="pt-2">
              <div
                className={`rounded-lg border p-3 transition-colors duration-200 ${
                  selected ? 'border-emerald-500 bg-emerald-50' : 'border-slate-200'
                }`}
              >
              <button
                type="button"
                onClick={() => onSelect(group)}
                className="block w-full text-left"
                aria-label={`Show ${group.name} on the map`}
              >
                <span className="block text-sm font-medium text-slate-900">{group.name}</span>
                <span className="block text-xs text-slate-500">{people(group.memberCount)}</span>
              </button>

              <Reveal show={!!(group.status === 'pending' && group.viewerIsFounder)}>{(group.status === 'pending' && group.viewerIsFounder) && (
                <p className="mt-1 text-xs text-amber-800">
                  Waiting to be checked.{' '}
                  {group.memberCount > 1
                    ? 'Only the people in it can see it until then.'
                    : 'Only you can see it until then.'}
                </p>
              )}</Reveal>
              <Reveal show={group.status === 'pending' && !group.viewerIsFounder && group.viewerIsMember}>
                <p className="mt-1 text-xs text-amber-800">
                  Hidden while it is checked again. Only the people in it can see it.
                </p>
              </Reveal>
              <Reveal show={group.status === 'rejected' && !group.viewerIsFounder && group.viewerIsMember}>
                <p className="mt-1 text-xs text-rose-800">
                  This group was taken down, so nobody else can see it. You can still leave it.
                </p>
              </Reveal>
              <Reveal show={!!(group.status === 'rejected' && group.viewerIsFounder)}>{(group.status === 'rejected' && group.viewerIsFounder) && (
                <p className="mt-1 text-xs text-rose-800">
                  {group.memberCount > 1
                    ? 'This group was not accepted, so only the people in it can see it.'
                    : 'This group was not accepted, so nobody else can see it.'}
                </p>
              )}</Reveal>

              <Reveal show={!!(group.description)}>{(group.description) && (
                <p className="mt-1 whitespace-pre-line text-xs text-slate-700">{group.description}</p>
              )}</Reveal>

              <div className="mt-2 flex flex-wrap gap-2">
                <Swap
                  inline
                  id={
                    !signedIn
                      ? 'signed-out'
                      : group.viewerIsMember
                        ? 'leave'
                        : group.status === 'approved' || group.viewerIsFounder
                          ? 'join'
                          : 'none'
                  }
                >
                {signedIn ? (
                  group.viewerIsMember ? (
                    <button
                      type="button"
                      disabled={busy === group.id}
                      onClick={() => void act(group, () => data.leaveGroup(group.id))}
                      className="rounded-lg border border-slate-300 px-3 py-1 text-xs text-slate-700"
                    >
                      Leave
                    </button>
                  ) : (
                    // A founder can always rejoin their own group, even while
                    // it waits: leaving it must not strand them outside it.
                    (group.status === 'approved' || group.viewerIsFounder) && (
                      <button
                        type="button"
                        disabled={busy === group.id}
                        onClick={() => void act(group, () => data.joinGroup(group.id))}
                        className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white"
                      >
                        Join
                      </button>
                    )
                  )
                ) : (
                  <span className="text-xs text-slate-500">Sign in to join.</span>
                )}
                </Swap>

                {(group.viewerIsFounder || isAdmin) && (
                  <button
                    type="button"
                    disabled={busy === group.id || confirming === group.id}
                    aria-expanded={confirming === group.id}
                    onClick={() => setConfirming(group.id)}
                    className="rounded-lg px-3 py-1 text-xs text-rose-700 hover:bg-rose-50"
                  >
                    Delete group
                  </button>
                )}

                {signedIn && !group.viewerIsFounder && group.status === 'approved' && (
                  <Swap inline id={reported.has(group.id) ? 'reported' : 'report'}>
                  {reported.has(group.id) ? (
                    <span className="px-1 py-1 text-xs text-slate-500">Reported. Thank you.</span>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === group.id}
                      onClick={() =>
                        void act(group, async () => {
                          await data.flag('group', group.id, 'Reported from the list of cleaning groups')
                          setReported((current) => new Set(current).add(group.id))
                        })
                      }
                      className="rounded-lg px-3 py-1 text-xs text-slate-500 hover:bg-slate-100"
                    >
                      Report this group
                    </button>
                  )}
                  </Swap>
                )}
              </div>

              <Reveal show={!!(confirming === group.id)}>{(confirming === group.id) && (
                <div role="alertdialog" aria-label={`Delete ${group.name}?`} className="mt-2 rounded-lg bg-rose-50 p-2">
                  <p className="text-xs text-rose-900">
                    Delete this group for everyone in it? This cannot be undone.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      disabled={busy === group.id}
                      onClick={() =>
                        void act(group, async () => {
                          await data.deleteGroup(group.id)
                          setConfirming(null)
                        })
                      }
                      className="rounded-lg bg-rose-700 px-3 py-1 text-xs font-medium text-white"
                    >
                      Yes, delete it
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirming(null)}
                      className="rounded-lg px-3 py-1 text-xs text-slate-700 hover:bg-white"
                    >
                      Keep it
                    </button>
                  </div>
                </div>
              )}</Reveal>

              <Reveal show={!!(problem?.id === group.id)}>{(problem?.id === group.id) && (
                <p role="alert" className="mt-2 text-xs text-rose-800">
                  {problem.message}
                </p>
              )}</Reveal>
              </div>
              </Reveal>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
