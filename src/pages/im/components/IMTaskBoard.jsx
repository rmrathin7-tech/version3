import React, { useState, useEffect, useMemo } from 'react';
import { 
  Kanban, ListTree, Plus, X, Search, Clock, 
  CheckCircle2, CircleDashed, ArrowRight, UserPlus,
  GripVertical
} from 'lucide-react';
import { db, auth } from '../../../firebase';
import { 
  collection, query, where, onSnapshot, addDoc, 
  updateDoc, doc, serverTimestamp, deleteDoc 
} from 'firebase/firestore';

const AVATAR_COLORS = ['#3b82f6','#10b981','#8b5cf6','#f59e0b','#ec4899','#06b6d4'];
const avatarColor = (uid) => AVATAR_COLORS[(uid?.charCodeAt(0) || 0) % AVATAR_COLORS.length];

const COLUMNS = [
  { id: 'pending', label: 'Pending Allocation', color: '#f59e0b', icon: <CircleDashed size={14} /> },
  { id: 'drafting', label: 'Drafting', color: '#3b82f6', icon: <Clock size={14} /> },
  { id: 'reviewing', label: 'Reviewing', color: '#a855f7', icon: <Search size={14} /> },
  { id: 'approved', label: 'Approved', color: '#10b981', icon: <CheckCircle2 size={14} /> }
];

export default function IMTaskBoard({ imId, projectId, isDark = true, onClose }) {
  const [viewMode, setViewMode] = useState('kanban'); // 'kanban' | 'matrix'
  const [tasks, setTasks] = useState([]);
  const [schema, setSchema] = useState([]);
  const [workspaceUsers, setWorkspaceUsers] = useState([]);
  
  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [newTask, setNewTask] = useState({ title: '', assignee: '', linkedSections: [] });
  const [searchQuery, setSearchQuery] = useState('');

  const T = useMemo(() => ({
    bg:         isDark ? '#060910' : '#f1f5f9',
    surface:    isDark ? '#0d1117' : '#ffffff',
    surface2:   isDark ? '#161b22' : '#f8fafc',
    border:     isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)',
    text:       isDark ? '#f1f5f9' : '#0f172a',
    textMuted:  isDark ? '#64748b' : '#94a3b8',
    accent:     '#ef4444',
  }), [isDark]);

  // ── DATA FETCHING ──
  useEffect(() => {
    if (!imId) return;

    // 1. Fetch Schema (to know the sections)
    const unsubSchema = onSnapshot(doc(db, 'config', 'im-schema'), (snap) => {
      if (snap.exists()) setSchema(snap.data().sections || []);
    });

    // 2. Fetch Tasks for this IM
    const qTasks = query(collection(db, 'im-tasks'), where('imId', '==', imId));
    const unsubTasks = onSnapshot(qTasks, (snap) => {
      setTasks(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    // 3. Fetch Workspace Users (for assignment)
    const unsubUsers = onSnapshot(collection(db, 'workspace-users'), (snap) => {
      setWorkspaceUsers(snap.docs.map(d => d.data()));
    });

    return () => { unsubSchema(); unsubTasks(); unsubUsers(); };
  }, [imId]);

  // ── HELPERS ──
  const flatSections = useMemo(() => {
    const result = [];
    const parents = schema.filter(s => !s.parentId).sort((a,b) => (a.order||0) - (b.order||0));
    parents.forEach(p => {
      result.push({ ...p, isParent: true });
      schema.filter(s => s.parentId === p.id).sort((a,b) => (a.order||0) - (b.order||0))
            .forEach(c => result.push({ ...c, isParent: false }));
    });
    return result;
  }, [schema]);

  const getSectionName = (key) => flatSections.find(s => s.key === key)?.navLabel || key;

  // ── DRAG AND DROP HANDLERS ──
  const handleDragStart = (e, taskId) => {
    e.dataTransfer.setData('taskId', taskId);
    e.currentTarget.style.opacity = '0.4';
  };

  const handleDragEnd = (e) => {
    e.currentTarget.style.opacity = '1';
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.currentTarget.style.background = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)';
  };

  const handleDragLeave = (e) => {
    e.currentTarget.style.background = 'transparent';
  };

  const handleDrop = async (e, newStatus) => {
    e.preventDefault();
    e.currentTarget.style.background = 'transparent';
    const taskId = e.dataTransfer.getData('taskId');
    if (!taskId) return;

    try {
      await updateDoc(doc(db, 'im-tasks', taskId), { 
        status: newStatus,
        updatedAt: serverTimestamp() 
      });
    } catch (err) {
      console.error("Failed to update status", err);
    }
  };

  // ── TASK CREATION ──
  const handleCreateTask = async () => {
    if (!newTask.title.trim()) return alert("Task needs a title");
    
    let assigneeObj = null;
    if (newTask.assignee) {
      const u = workspaceUsers.find(user => user.userId === newTask.assignee);
      if (u) assigneeObj = { uid: u.userId, email: u.email };
    }

    try {
      await addDoc(collection(db, 'im-tasks'), {
        imId,
        projectId,
        title: newTask.title,
        assignee: assigneeObj,
        linkedSections: newTask.linkedSections,
        status: 'pending',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      setIsModalOpen(false);
      setNewTask({ title: '', assignee: '', linkedSections: [] });
    } catch (err) {
      console.error("Failed to create task", err);
    }
  };

  const toggleSectionLink = (secKey) => {
    setNewTask(prev => {
      const exists = prev.linkedSections.includes(secKey);
      return {
        ...prev,
        linkedSections: exists 
          ? prev.linkedSections.filter(k => k !== secKey)
          : [...prev.linkedSections, secKey]
      };
    });
  };

  // ── RENDERERS ──
  const renderKanban = () => (
    <div style={{ display: 'flex', gap: '20px', height: '100%', overflowX: 'auto', paddingBottom: '20px' }}>
      {COLUMNS.map(col => {
        const colTasks = tasks.filter(t => t.status === col.id);
        
        return (
          <div 
            key={col.id}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, col.id)}
            style={{ 
              flex: '0 0 300px', 
              display: 'flex', flexDirection: 'column',
              background: T.surface, 
              border: `1px solid ${T.border}`, 
              borderRadius: '12px',
              transition: 'background 0.2s ease'
            }}
          >
            {/* Column Header */}
            <div style={{ padding: '16px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: col.color, fontWeight: 700, fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                {col.icon} {col.label}
              </div>
              <div style={{ background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)', color: T.textMuted, padding: '2px 8px', borderRadius: '12px', fontSize: '0.75rem', fontWeight: 800 }}>
                {colTasks.length}
              </div>
            </div>

            {/* Cards Area */}
            <div style={{ flex: 1, padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {colTasks.map(task => (
                <div 
                  key={task.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, task.id)}
                  onDragEnd={handleDragEnd}
                  style={{
                    background: T.surface2,
                    border: `1px solid ${T.border}`,
                    borderRadius: '8px',
                    padding: '14px',
                    cursor: 'grab',
                    boxShadow: isDark ? '0 4px 12px rgba(0,0,0,0.2)' : '0 2px 8px rgba(0,0,0,0.05)',
                    transition: 'transform 0.1s, box-shadow 0.1s'
                  }}
                  onMouseEnter={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                  onMouseLeave={e => e.currentTarget.style.transform = 'translateY(0)'}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <h4 style={{ margin: 0, fontSize: '0.9rem', fontWeight: 600, color: T.text, lineHeight: 1.4 }}>
                      {task.title}
                    </h4>
                    <GripVertical size={14} color={T.textMuted} style={{ cursor: 'grab', opacity: 0.5 }} />
                  </div>

                  {/* Attached Sections */}
                  {task.linkedSections?.length > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '12px' }}>
                      {task.linkedSections.map(secKey => (
                        <span key={secKey} style={{ 
                          fontSize: '0.65rem', fontWeight: 600, 
                          color: T.textMuted, background: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', 
                          border: `1px solid ${T.border}`, borderRadius: '4px', padding: '2px 6px',
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%'
                        }}>
                          {getSectionName(secKey)}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Assignee Footer */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: '10px', borderTop: `1px dashed ${T.border}` }}>
                    {task.assignee ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ width: 22, height: 22, borderRadius: '50%', background: avatarColor(task.assignee.uid), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.65rem', fontWeight: 800 }}>
                          {task.assignee.email.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontSize: '0.75rem', color: T.textMuted, fontWeight: 500 }}>
                          {task.assignee.email.split('@')[0]}
                        </span>
                      </div>
                    ) : (
                      <span style={{ fontSize: '0.75rem', color: T.textMuted, fontStyle: 'italic' }}>Unassigned</span>
                    )}
                    
                    <button 
                      onClick={() => deleteDoc(doc(db, 'im-tasks', task.id))}
                      style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer', opacity: 0.6 }}
                      onMouseEnter={e => { e.currentTarget.style.color = '#ef4444'; e.currentTarget.style.opacity = '1'; }}
                      onMouseLeave={e => { e.currentTarget.style.color = T.textMuted; e.currentTarget.style.opacity = '0.6'; }}
                    >
                      <X size={14} />
                    </button>
                  </div>
                </div>
              ))}
              {colTasks.length === 0 && (
                <div style={{ padding: '20px', textAlign: 'center', color: T.textMuted, fontSize: '0.8rem', fontStyle: 'italic', border: `1px dashed ${T.border}`, borderRadius: '8px' }}>
                  Drag cards here
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderMatrix = () => (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', padding: '16px 24px', background: T.surface2, borderBottom: `1px solid ${T.border}`, fontSize: '0.75rem', fontWeight: 800, color: T.textMuted, textTransform: 'uppercase', letterSpacing: '1px' }}>
        <div>Document Section</div>
        <div>Current Assignee</div>
        <div>Task Status</div>
      </div>
      
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {flatSections.map(section => {
          // Find the active task linked to this section
          const activeTask = tasks.find(t => t.linkedSections?.includes(section.key));
          const colDef = activeTask ? COLUMNS.find(c => c.id === activeTask.status) : null;

          return (
            <div key={section.id} style={{ 
              display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', 
              padding: '16px 24px', borderBottom: `1px solid ${T.border}`,
              alignItems: 'center', transition: 'background 0.2s'
            }}
              onMouseEnter={e => e.currentTarget.style.background = isDark ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.01)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                {!section.isParent && <ArrowRight size={14} color={T.textMuted} style={{ marginLeft: '16px' }} />}
                <span style={{ fontSize: section.isParent ? '0.95rem' : '0.85rem', fontWeight: section.isParent ? 700 : 500, color: section.isParent ? T.text : T.textMuted }}>
                  {section.navLabel}
                </span>
              </div>
              
              <div>
                {activeTask?.assignee ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: avatarColor(activeTask.assignee.uid), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '0.7rem', fontWeight: 800 }}>
                      {activeTask.assignee.email.charAt(0).toUpperCase()}
                    </div>
                    <span style={{ fontSize: '0.85rem', color: T.text }}>{activeTask.assignee.email.split('@')[0]}</span>
                  </div>
                ) : (
                  <span style={{ fontSize: '0.8rem', color: T.textMuted, fontStyle: 'italic' }}>Unassigned</span>
                )}
              </div>

              <div>
                {activeTask && colDef ? (
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', borderRadius: '20px', background: `${colDef.color}15`, border: `1px solid ${colDef.color}40`, color: colDef.color, fontSize: '0.75rem', fontWeight: 700 }}>
                    {colDef.icon} {colDef.label}
                  </div>
                ) : (
                  <span style={{ fontSize: '0.8rem', color: T.textMuted }}>-</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1000, background: T.bg, display: 'flex', flexDirection: 'column', animation: 'imFadeIn 0.2s ease-out' }}>
      
      {/* HEADER */}
      <header style={{ height: '70px', padding: '0 32px', background: T.surface, borderBottom: `1px solid ${T.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.2rem', fontWeight: 800, color: T.text, letterSpacing: '-0.5px' }}>Dossier Mission Control</h1>
            <span style={{ fontSize: '0.75rem', color: T.textMuted, textTransform: 'uppercase', letterSpacing: '1px' }}>Operations Board</span>
          </div>
          
          <div style={{ width: '1px', height: '32px', background: T.border }} />

          <div style={{ display: 'flex', background: isDark ? 'rgba(0,0,0,0.3)' : '#f1f5f9', padding: '4px', borderRadius: '8px', border: `1px solid ${T.border}` }}>
            <button onClick={() => setViewMode('kanban')} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, background: viewMode === 'kanban' ? (isDark ? 'rgba(255,255,255,0.1)' : '#fff') : 'transparent', color: viewMode === 'kanban' ? T.text : T.textMuted, boxShadow: viewMode === 'kanban' ? '0 2px 8px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.2s' }}>
              <Kanban size={15} /> Kanban Board
            </button>
            <button onClick={() => setViewMode('matrix')} style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 14px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '0.8rem', fontWeight: 700, background: viewMode === 'matrix' ? (isDark ? 'rgba(255,255,255,0.1)' : '#fff') : 'transparent', color: viewMode === 'matrix' ? T.text : T.textMuted, boxShadow: viewMode === 'matrix' ? '0 2px 8px rgba(0,0,0,0.1)' : 'none', transition: 'all 0.2s' }}>
              <ListTree size={15} /> Section Matrix
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button 
            onClick={() => setIsModalOpen(true)}
            style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 20px', borderRadius: '8px', background: T.accent, color: '#fff', border: 'none', fontWeight: 700, fontSize: '0.85rem', cursor: 'pointer', boxShadow: `0 4px 14px rgba(239,68,68,0.3)` }}
          >
            <Plus size={16} /> Create Allocation
          </button>
          <button onClick={onClose} style={{ background: 'none', border: `1px solid ${T.border}`, color: T.textMuted, padding: '8px', borderRadius: '8px', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>
      </header>

      {/* WORKSPACE AREA */}
      <main style={{ flex: 1, padding: '32px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {viewMode === 'kanban' ? renderKanban() : (
          <div style={{ height: '100%', overflowY: 'auto', paddingRight: '12px' }}>
            {renderMatrix()}
          </div>
        )}
      </main>

      {/* CREATE TASK MODAL */}
      {isModalOpen && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1100, background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: '16px', width: '500px', boxShadow: '0 24px 60px rgba(0,0,0,0.5)', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '20px 24px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2 style={{ margin: 0, fontSize: '1.1rem', color: T.text }}>Create Task Allocation</h2>
              <button onClick={() => setIsModalOpen(false)} style={{ background: 'none', border: 'none', color: T.textMuted, cursor: 'pointer' }}><X size={18} /></button>
            </div>
            
            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px', maxHeight: '60vh', overflowY: 'auto' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', marginBottom: '8px' }}>Task Description</label>
                <input 
                  type="text" 
                  autoFocus
                  placeholder="e.g. Draft Q3 Financial Review" 
                  value={newTask.title} 
                  onChange={e => setNewTask({...newTask, title: e.target.value})}
                  style={{ width: '100%', padding: '12px', borderRadius: '8px', background: T.bg, border: `1px solid ${T.border}`, color: T.text, outline: 'none', fontSize: '0.9rem' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', marginBottom: '8px' }}>Assign To</label>
                <select 
                  value={newTask.assignee}
                  onChange={e => setNewTask({...newTask, assignee: e.target.value})}
                  style={{ width: '100%', padding: '12px', borderRadius: '8px', background: T.bg, border: `1px solid ${T.border}`, color: T.text, outline: 'none', fontSize: '0.9rem', cursor: 'pointer' }}
                >
                  <option value="">Unassigned</option>
                  {workspaceUsers.map(u => (
                    <option key={u.userId} value={u.userId}>{u.email}</option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: T.textMuted, textTransform: 'uppercase', marginBottom: '8px' }}>Link Sections</label>
                <div style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: '8px', padding: '12px', maxHeight: '200px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {flatSections.map(sec => (
                    <label key={sec.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '0.85rem', color: T.text, cursor: 'pointer', marginLeft: sec.isParent ? '0' : '20px' }}>
                      <input 
                        type="checkbox" 
                        checked={newTask.linkedSections.includes(sec.key)}
                        onChange={() => toggleSectionLink(sec.key)}
                        style={{ accentColor: T.accent }}
                      />
                      <span style={{ fontWeight: sec.isParent ? 700 : 400 }}>{sec.navLabel}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ padding: '20px 24px', borderTop: `1px solid ${T.border}`, display: 'flex', gap: '12px' }}>
              <button onClick={() => setIsModalOpen(false)} style={{ flex: 1, padding: '12px', borderRadius: '8px', border: `1px solid ${T.border}`, background: 'transparent', color: T.text, cursor: 'pointer', fontWeight: 600 }}>Cancel</button>
              <button onClick={handleCreateTask} style={{ flex: 1, padding: '12px', borderRadius: '8px', background: T.accent, color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600 }}>Create Allocation</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}