import { useState, useEffect, useCallback } from 'react';
import {
  listMappedKeys,
  createMappedKey,
  deleteMappedKey,
  type MappedKey,
} from '../api/mappedKeys';
import './SettingsMappedKeys.css';

export default function SettingsMappedKeys() {
  const [keys, setKeys] = useState<MappedKey[]>([]);
  const [loading, setLoading] = useState(true);

  // New key form state
  const [isCapturingKey, setIsCapturingKey] = useState(false);
  const [capturedKeyCombo, setCapturedKeyCombo] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [newDescription, setNewDescription] = useState('');

  useEffect(() => {
    listMappedKeys()
      .then(setKeys)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Key capture handler
  const handleKeyCapture = useCallback((e: KeyboardEvent) => {
    if (!isCapturingKey) return;
    e.preventDefault();
    e.stopPropagation();

    const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    let key = e.key;
    if (key === ' ') key = 'Space';
    else if (key.length === 1) key = key.toUpperCase();

    // Don't add modifier keys alone
    if (!['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
      parts.push(key);
      setCapturedKeyCombo(parts.join('+'));
      setIsCapturingKey(false);
    }
  }, [isCapturingKey]);

  // Attach/detach key listener for capture mode
  useEffect(() => {
    if (isCapturingKey) {
      window.addEventListener('keydown', handleKeyCapture, true);
      return () => window.removeEventListener('keydown', handleKeyCapture, true);
    }
  }, [isCapturingKey, handleKeyCapture]);

  const handleAdd = useCallback(async () => {
    if (!capturedKeyCombo.trim() || !newCommand.trim()) return;
    try {
      const created = await createMappedKey({
        key_combo: capturedKeyCombo.trim(),
        command: newCommand.trim(),
        description: newDescription.trim() || null,
      });
      setKeys(prev => [...prev, created]);
      setCapturedKeyCombo('');
      setNewCommand('');
      setNewDescription('');
    } catch (err) {
      console.error('Failed to create mapped key:', err);
    }
  }, [capturedKeyCombo, newCommand, newDescription]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await deleteMappedKey(id);
      setKeys(prev => prev.filter(k => k.id !== id));
    } catch (err) {
      console.error('Failed to delete mapped key:', err);
    }
  }, []);

  if (loading) {
    return <div className="mapped-keys-settings"><div className="mapped-keys-loading">Loading mapped keys...</div></div>;
  }

  return (
    <div className="mapped-keys-settings">
      <div className="mapped-keys-section">
        <div className="mapped-keys-section-header">
          <span className="mapped-keys-section-title">Keyboard Shortcuts</span>
        </div>
        <div className="mapped-keys-section-description">
          Define keyboard shortcuts that send commands to the terminal. These apply to all sessions.
        </div>

        {keys.length === 0 && (
          <div className="mapped-keys-empty">
            No mapped keys configured. Add a keyboard shortcut below.
          </div>
        )}

        {keys.length > 0 && (
          <div className="mapped-keys-list">
            {keys.map((key) => (
              <div key={key.id} className="mapped-keys-item">
                <div className="mapped-keys-item-main">
                  <span className="mapped-keys-combo">{key.key_combo}</span>
                  <span className="mapped-keys-arrow">&rarr;</span>
                  <span className="mapped-keys-command">{key.command}</span>
                  <button
                    className="mapped-keys-delete"
                    onClick={() => handleDelete(key.id)}
                    title="Delete"
                  >
                    &times;
                  </button>
                </div>
                {key.description && (
                  <div className="mapped-keys-description">{key.description}</div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="mapped-keys-add">
          <div className="mapped-keys-add-row">
            <div className="mk-capture-row">
              <button
                type="button"
                className={`mk-capture-btn ${isCapturingKey ? 'capturing' : ''}`}
                onClick={() => setIsCapturingKey(true)}
              >
                {isCapturingKey
                  ? 'Press a key combo...'
                  : capturedKeyCombo || 'Click to capture key'}
              </button>
              {capturedKeyCombo && !isCapturingKey && (
                <button
                  type="button"
                  className="mk-capture-clear"
                  onClick={() => setCapturedKeyCombo('')}
                  title="Clear"
                >
                  &times;
                </button>
              )}
            </div>
            <input
              type="text"
              placeholder="Command to send"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && capturedKeyCombo && newCommand.trim()) {
                  e.preventDefault();
                  handleAdd();
                }
              }}
              className="mk-input-command"
            />
            <button
              type="button"
              className="mk-add-btn"
              onClick={handleAdd}
              disabled={!capturedKeyCombo || !newCommand.trim()}
              title="Add shortcut"
            >
              +
            </button>
          </div>
          <input
            type="text"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            className="mk-input-description"
          />
        </div>
      </div>
    </div>
  );
}
