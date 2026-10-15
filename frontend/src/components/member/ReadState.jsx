export default function ReadState({ query, children, label = 'data' }) {
  if (query.isLoading || query.isPending)
    return (
      <p role="status" className="p-6">
        Loading {label}…
      </p>
    );
  if (query.isError)
    return (
      <div role="alert" className="p-6 space-y-2">
        <p>Could not load {label}. Please retry.</p>
        <button onClick={() => query.refetch()}>Retry {label}</button>
      </div>
    );
  return (
    <>
      {children}
      {query.isRefetchError && (
        <p role="alert">
          Refresh failed. <button onClick={() => query.refetch()}>Retry</button>
        </p>
      )}
    </>
  );
}
