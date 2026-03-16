'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import AccessRequestsTab from '@/components/admin/AccessRequestsTab';
import EventManagementTab from '@/components/admin/EventManagementTab';
import UserManagementTab from '@/components/admin/UserManagementTab';
import SupportTicketsTab from '@/components/admin/SupportTicketsTab';
import BatchAccountsTab from '@/components/admin/BatchAccountsTab';
import BlocklistTab from '@/components/admin/BlocklistTab';
import VPNManagementTab from '@/components/admin/VPNManagementTab';
import SystemSettingsTab from '@/components/admin/SystemSettingsTab';
import LogsTab from '@/components/admin/LogsTab';
import SessionManagementTab from '@/components/admin/SessionManagementTab';
import AccountLifecycleTab from '@/components/admin/AccountLifecycleTab';
import AccountSyncStatusTab from '@/components/admin/AccountSyncStatusTab';
import CommunicationsTab from '@/components/admin/CommunicationsTab';
import { useAdminPageTracking } from '@/hooks/useAdminPageTracking';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Search, Settings, Users, Shield, Activity, RefreshCw,
  Ban, Monitor, FileText, Ticket, Package, Calendar,
  ChevronDown, Menu, ClipboardList, LifeBuoy, Layers
} from "lucide-react";

interface AccessRequest {
  id: string;
  createdAt: string;
  name: string;
  email: string;
  isInternal: boolean;
  needsDomainAccount: boolean;
  institution?: string;
  eventReason?: string;
  eventId?: string;
  event?: { id: string; name: string; };
  accountExpiresAt?: string;
  isVerified: boolean;
  status: string;
  verifiedAt?: string;
}

interface Event {
  id: string;
  name: string;
  description?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count: { accessRequests: number; };
}

interface LDAPUser {
  dn: string;
  username: string;
  displayName: string;
  email: string;
  description: string;
  accountEnabled: boolean;
  accountExpires: string | null;
  whenCreated: string;
  memberOf: string[];
}

interface TicketResponse {
  id: string;
  message: string;
  author: string;
  isStaff: boolean;
  createdAt: string;
}

interface TicketStatusLog {
  id: string;
  createdAt: string;
  oldStatus: string | null;
  newStatus: string;
  changedBy: string;
  isStaff: boolean;
}

interface SupportTicket {
  id: string;
  subject: string;
  category: string | null;
  severity: string | null;
  body: string;
  status: string;
  username: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  closedBy: string | null;
  responses: TicketResponse[];
  statusLogs: TicketStatusLog[];
}

interface BatchCreation {
  id: string;
  createdAt: string;
  createdBy: string;
  description: string;
  totalAccounts: number;
  successfulAccounts: number;
  failedAccounts: number;
  status: string;
  completedAt?: string;
  linkedTicket?: {
    id: string;
    subject: string;
    status: string;
  };
  accounts: Array<{
    id: string;
    name: string;
    ldapUsername: string;
    status: string;
    errorMessage?: string;
  }>;
  _count: {
    accounts: number;
    auditLogs: number;
  };
}

interface VPNAccount {
  id: string;
  username: string;
  name: string;
  email: string;
  portalType: string;
  isInternal: boolean;
  status: string;
  expiresAt?: string;
  createdAt: string;
  createdBy: string;
  createdByFaculty: boolean;
  facultyCreatedAt?: string;
  disabledAt?: string;
  disabledBy?: string;
  disabledReason?: string;
  notes?: string;
  adUsername?: string; // Linked AD account username
}

interface SyncStatusAccount {
  identifier: string;
  name: string;
  email: string;
  hasAdAccount: boolean;
  adUsername: string | null;
  adDisplayName: string | null;
  adEmail: string | null;
  adSyncDate: string | null;
  hasVpnAccount: boolean;
  vpnUsername: string | null;
  vpnPortalType: string | null;
  vpnStatus: string | null;
  vpnCreatedAt: string | null;
  hasAccessRequest: boolean;
  requestId: string | null;
  requestStatus: string | null;
  requestCreatedAt: string | null;
  isManuallyAssigned: boolean;
  syncStatus: 'fully_synced' | 'partial_sync' | 'ad_only' | 'vpn_only' | 'request_only' | 'orphaned';
  syncIssues: string[];
  lastSyncId: string | null;
  wasAutoAssigned: boolean;
}

export default function AdminDashboard() {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'requests' | 'events' | 'users' | 'support' | 'batch' | 'vpn' | 'blocklist' | 'settings' | 'logs' | 'sessions' | 'lifecycle' | 'sync-status' | 'communications'>('requests');
  const [events, setEvents] = useState<Event[]>([]);
  const [eventsLoading, setEventsLoading] = useState(true);
  const [users, setUsers] = useState<LDAPUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [supportTickets, setSupportTickets] = useState<SupportTicket[]>([]);
  const [supportTicketsLoading, setSupportTicketsLoading] = useState(true);
  const [batches, setBatches] = useState<BatchCreation[]>([]);
  const [, setBatchesLoading] = useState(false);
  const [vpnAccounts, setVpnAccounts] = useState<VPNAccount[]>([]);
  const [vpnAccountsLoading, setVpnAccountsLoading] = useState(true);
  const [syncStatusAccounts, setSyncStatusAccounts] = useState<SyncStatusAccount[]>([]);
  const [syncStatusLoading, setSyncStatusLoading] = useState(false);
  const [latestSync, setLatestSync] = useState<any>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    document.title = 'Admin Dashboard | User Access Request (UAR) Portal';
  }, []);

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && ['requests', 'events', 'users', 'support', 'batch', 'vpn', 'blocklist', 'settings', 'logs', 'sessions', 'lifecycle', 'sync-status', 'communications'].includes(tab)) {
      setActiveTab(tab as any);
    }
  }, [searchParams]);

  // Track page views for the active tab
  const getCategoryForTab = (tab: string) => {
    const categoryMap: Record<string, string> = {
      requests: 'access_request',
      batch: 'batch',
      vpn: 'vpn',
      support: 'support',
      blocklist: 'blocklist',
      events: 'event',
      users: 'user',
      settings: 'settings',
      logs: 'logs',
      sessions: 'session',
      lifecycle: 'lifecycle',
      'sync-status': 'sync_status',
      communications: 'communications',
    };
    return categoryMap[tab] || 'navigation';
  };

  useAdminPageTracking(`Admin Dashboard - ${activeTab}`, getCategoryForTab(activeTab));

  useEffect(() => {
    const fetchRequests = async () => {
      try {
        const response = await fetch('/api/admin/requests');
        if (response.status === 401 || response.status === 403) {
          router.push('`/login?redirect=`' + encodeURIComponent('/admin'));
          return;
        }
        if (!response.ok) throw new Error('Failed to fetch requests');
        const data = await response.json();
        setRequests(data.requests);
      } catch (error) {
        console.error('Error fetching requests:', error);
      } finally {
        setIsLoading(false);
      }
    };

    const fetchEvents = async () => {
      try {
        const response = await fetch('/api/admin/events');
        if (response.status === 401 || response.status === 403) {
          router.push('`/login?redirect=`' + encodeURIComponent('/admin'));
          return;
        }
        if (!response.ok) throw new Error('Failed to fetch events');
        const data = await response.json();
        setEvents(data.events);
      } catch (error) {
        console.error('Error fetching events:', error);
      } finally {
        setEventsLoading(false);
      }
    };

    const fetchUsers = async () => {
      try {
        const response = await fetch('/api/admin/users');
        if (response.status === 401 || response.status === 403) {
          router.push('`/login?redirect=`' + encodeURIComponent('/admin'));
          return;
        }
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          const errorMsg = errorData.details || errorData.error || 'Unknown error';

          // Handle LDAP sizing limit exceeded error
          if (errorMsg.includes('0x4') || errorMsg.includes('0x2c')) {
            console.warn('LDAP query size limit exceeded. Some users may not be displayed.');
            // Set empty array instead of throwing - the tab will show "no users" message
            setUsers([]);
            return;
          }

          throw new Error('Failed to fetch users: ' + errorMsg);
        }
        const data = await response.json();
        setUsers(data.users || []);
      } catch (error) {
        console.error('Error fetching users:', error);
        // Don't show alert for known LDAP limit errors
        if (error instanceof Error && !error.message.includes('0x')) {
          console.error('Unexpected error loading users:', error.message);
        }
      } finally {
        setUsersLoading(false);
      }
    };

    const fetchSupportTickets = async () => {
      try {
        const response = await fetch('/api/admin/support/tickets');
        if (response.status === 401 || response.status === 403) {
          router.push('/login?redirect=' + encodeURIComponent('/admin'));
          return;
        }
        if (!response.ok) throw new Error('Failed to fetch support tickets');
        const data = await response.json();
        setSupportTickets(data.tickets || []);
      } catch (error) {
        console.error('Error fetching support tickets:', error);
      } finally {
        setSupportTicketsLoading(false);
      }
    };

    const fetchBatches = async () => {
      try {
        const response = await fetch('/api/admin/batch-accounts');
        if (response.status === 401 || response.status === 403) {
          router.push('/login?redirect=' + encodeURIComponent('/admin'));
          return;
        }
        if (!response.ok) throw new Error('Failed to fetch batches');
        const data = await response.json();
        setBatches(data.batches || []);
      } catch (error) {
        console.error('Error fetching batches:', error);
      } finally {
        setBatchesLoading(false);
      }
    };

    const fetchVpnAccounts = async () => {
      try {
        const response = await fetch('/api/admin/vpn-accounts');
        if (response.status === 401 || response.status === 403) {
          router.push('/login?redirect=' + encodeURIComponent('/admin'));
          return;
        }
        if (!response.ok) throw new Error('Failed to fetch VPN accounts');
        const data = await response.json();
        setVpnAccounts(data.accounts || []);
      } catch (error) {
        console.error('Error fetching VPN accounts:', error);
      } finally {
        setVpnAccountsLoading(false);
      }
    };

    const fetchSyncStatus = async () => {
      if (activeTab !== 'sync-status') return;
      try {
        setSyncStatusLoading(true);
        const response = await fetch('/api/admin/sync-status');
        if (response.status === 401 || response.status === 403) {
          router.push('/login?redirect=' + encodeURIComponent('/admin'));
          return;
        }
        if (!response.ok) throw new Error('Failed to fetch sync status');
        const data = await response.json();
        setSyncStatusAccounts(data.accounts || []);
        setLatestSync(data.latestSync || null);
      } catch (error) {
        console.error('Error fetching sync status:', error);
      } finally {
        setSyncStatusLoading(false);
      }
    };

    fetchRequests();
    fetchEvents();
    fetchUsers();
    fetchSupportTickets();
    fetchBatches();
    fetchVpnAccounts();
    fetchSyncStatus();
  }, [router, activeTab]);

  const fetchEvents = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/events');
      if (response.status === 401 || response.status === 403) {
        router.push('`/login?redirect=`' + encodeURIComponent('/admin'));
        return;
      }
      if (!response.ok) throw new Error('Failed to fetch events');
      const data = await response.json();
      setEvents(data.events);
    } catch (error) {
      console.error('Error fetching events:', error);
    } finally {
      setEventsLoading(false);
    }
  }, [router]);

  const fetchSupportTickets = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/support/tickets');
      if (response.status === 401 || response.status === 403) {
        router.push('/login?redirect=' + encodeURIComponent('/admin'));
        return;
      }
      if (!response.ok) throw new Error('Failed to fetch support tickets');
      const data = await response.json();
      setSupportTickets(data.tickets || []);
    } catch (error) {
      console.error('Error fetching support tickets:', error);
    } finally {
      setSupportTicketsLoading(false);
    }
  }, [router]);

  const fetchBatches = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/batch-accounts');
      if (response.status === 401 || response.status === 403) {
        router.push('/login?redirect=' + encodeURIComponent('/admin'));
        return;
      }
      if (!response.ok) throw new Error('Failed to fetch batches');
      const data = await response.json();
      setBatches(data.batches || []);
    } catch (error) {
      console.error('Error fetching batches:', error);
    } finally {
      setBatchesLoading(false);
    }
  }, [router]);

  const fetchVpnAccounts = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/vpn-accounts');
      if (response.status === 401 || response.status === 403) {
        router.push('/login?redirect=' + encodeURIComponent('/admin'));
        return;
      }
      if (!response.ok) throw new Error('Failed to fetch VPN accounts');
      const data = await response.json();
      setVpnAccounts(data.accounts || []);
    } catch (error) {
      console.error('Error fetching VPN accounts:', error);
    } finally {
      setVpnAccountsLoading(false);
    }
  }, [router]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      setSyncStatusLoading(true);
      const response = await fetch('/api/admin/sync-status');
      if (response.status === 401 || response.status === 403) {
        router.push('/login?redirect=' + encodeURIComponent('/admin'));
        return;
      }
      if (!response.ok) throw new Error('Failed to fetch sync status');
      const data = await response.json();
      setSyncStatusAccounts(data.accounts || []);
      setLatestSync(data.latestSync || null);
    } catch (error) {
      console.error('Error fetching sync status:', error);
    } finally {
      setSyncStatusLoading(false);
    }
  }, [router]);

  if (isLoading) {
    return (<div className="min-h-screen bg-linear-to-b from-white to-gray-100 flex items-center justify-center"><div className="text-gray-900 text-xl font-semibold">Loading...</div></div>);
  }

  return (
    <div className="min-h-screen bg-gray-50/50 text-gray-900">
      <div className="container mx-auto px-4 py-6 sm:py-8 space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-gray-900">Admin Dashboard</h1>
            <p className="text-gray-500 mt-1">Cal Poly Pomona Student SOC</p>
          </div>
          <Button asChild>
            <a href="/admin/search" className="gap-2">
              <Search className="h-4 w-4" />
              Global Search
            </a>
          </Button>
        </div>

        <Card className="shadow-sm">
          <div className="p-2 flex flex-wrap items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 h-9">
                  <Menu className="h-4 w-4" />
                  Operations
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onClick={() => setActiveTab('requests')} className="gap-2">
                  <ClipboardList className="h-4 w-4" /> Access Requests
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('support')} className="gap-2">
                  <LifeBuoy className="h-4 w-4" /> Support Tickets
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('batch')} className="gap-2">
                  <Package className="h-4 w-4" /> Batch Accounts
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('events')} className="gap-2">
                  <Calendar className="h-4 w-4" /> Events
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 h-9">
                  <Users className="h-4 w-4" />
                  Account Management
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onClick={() => setActiveTab('users')} className="gap-2">
                  <Users className="h-4 w-4" /> Active Directory
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('vpn')} className="gap-2">
                  <Shield className="h-4 w-4" /> VPN Management
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('lifecycle')} className="gap-2">
                  <Activity className="h-4 w-4" /> Account Lifecycle
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('sync-status')} className="gap-2">
                  <RefreshCw className="h-4 w-4" /> Sync Status
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('communications')} className="gap-2">
                  <Ticket className="h-4 w-4" /> Communications
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 h-9">
                  <Settings className="h-4 w-4" />
                  Configuration
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onClick={() => setActiveTab('settings')} className="gap-2">
                  <Settings className="h-4 w-4" /> System Settings
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('blocklist')} className="gap-2">
                  <Ban className="h-4 w-4" /> Blocklist
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="gap-2 h-9">
                  <Monitor className="h-4 w-4" />
                  Monitoring
                  <ChevronDown className="h-4 w-4 text-gray-500" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuItem onClick={() => setActiveTab('sessions')} className="gap-2">
                  <Users className="h-4 w-4" /> Active Sessions
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setActiveTab('logs')} className="gap-2">
                  <FileText className="h-4 w-4" /> Audit Logs
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <div className="ml-auto px-4 py-2 text-sm font-medium text-blue-600 hidden sm:block">
              {activeTab === 'requests' && 'Access Requests'}
              {activeTab === 'support' && 'Support Tickets'}
              {activeTab === 'batch' && 'Batch Accounts'}
              {activeTab === 'events' && 'Events'}
              {activeTab === 'users' && 'Active Directory'}
              {activeTab === 'vpn' && 'VPN Management'}
              {activeTab === 'lifecycle' && 'Account Lifecycle'}
              {activeTab === 'sync-status' && 'Account Sync Status'}
              {activeTab === 'settings' && 'System Settings'}
              {activeTab === 'blocklist' && 'Blocklist'}
              {activeTab === 'sessions' && 'Active Sessions'}
              {activeTab === 'logs' && 'Audit Logs'}
              {activeTab === 'communications' && 'Communications'}
            </div>
          </div>
        </Card>

        <Card className="shadow-sm">
          <CardContent className="p-6">
            {activeTab === 'requests' && <AccessRequestsTab requests={requests} />}
            {activeTab === 'batch' && (
              <BatchAccountsTab
                batches={batches}
                supportTickets={supportTickets.filter(t => t.status === 'open' || t.status === 'in-progress')}
                onBatchCreated={fetchBatches}
              />
            )}
            {activeTab === 'vpn' && <VPNManagementTab accounts={vpnAccounts} isLoading={vpnAccountsLoading} onRefresh={fetchVpnAccounts} />}
            {activeTab === 'lifecycle' && <AccountLifecycleTab />}
            {activeTab === 'sync-status' && <AccountSyncStatusTab accounts={syncStatusAccounts} isLoading={syncStatusLoading} onRefresh={fetchSyncStatus} latestSync={latestSync} />}
            {activeTab === 'communications' && <CommunicationsTab />}
            {activeTab === 'support' && <SupportTicketsTab tickets={supportTickets} isLoading={supportTicketsLoading} onRefresh={fetchSupportTickets} />}
            {activeTab === 'blocklist' && <BlocklistTab />}
            {activeTab === 'events' && <EventManagementTab events={events} isLoading={eventsLoading} onRefresh={fetchEvents} />}
            {activeTab === 'users' && <UserManagementTab users={users} isLoading={usersLoading} />}
            {activeTab === 'sessions' && <SessionManagementTab />}
            {activeTab === 'settings' && <SystemSettingsTab isLoading={false} onRefresh={() => { }} />}
            {activeTab === 'logs' && <LogsTab isLoading={false} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
