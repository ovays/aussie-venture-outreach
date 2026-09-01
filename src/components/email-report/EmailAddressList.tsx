interface EmailAddressListProps {
  addresses: string[]
  expanded: boolean
  onToggle: () => void
}

export function EmailAddressList({ addresses, expanded, onToggle }: EmailAddressListProps) {
  const additionalAddressCount = addresses.length - 1
  const visibleAddresses = expanded ? addresses : addresses.slice(0, 1)

  return (
    <div>
      <div className="space-y-1" style={{ color: '#cbd5e1' }}>
        {visibleAddresses.map((address, index) => (
          <span key={`${index}-${address}`} className="block truncate" title={address}>
            {address}
          </span>
        ))}
      </div>
      {additionalAddressCount > 0 && (
        <button
          type="button"
          className="mt-1 block text-left text-xs text-sky-400 hover:text-sky-300 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? 'Show less' : `+${additionalAddressCount} more`}
        </button>
      )}
    </div>
  )
}
