/**
 * Docker API Service
 * 
 * Manages Docker containers using the Docker Engine API directly.
 * This is more reliable than shelling out to docker-compose commands.
 * 
 * The Docker socket is mounted at /var/run/docker.sock
 * 
 * VPN Container Configuration:
 * The pia-qbittorrent container uses a startup wrapper (vpn-startup.sh) that reads
 * VPN configuration from config/vpn.conf before starting. This means:
 * - Credentials are read from auth.conf (bind-mounted)
 * - Region and other settings are read from vpn.conf (bind-mounted)
 * - A simple container restart is sufficient to apply any settings changes
 * - No complex docker-compose recreate is needed
 */

import http from 'http';
import fs from 'fs';

const DOCKER_SOCKET = '/var/run/docker.sock';
const CONTAINER_NAME = 'pia-qbittorrent';

interface ContainerInfo {
  Id: string;
  Names: string[];
  State: string;
  Status: string;
  Created: number;
}

interface ContainerInspect {
  Id: string;
  Name: string;
  State: {
    Status: string;
    Running: boolean;
    Paused: boolean;
    Restarting: boolean;
    OOMKilled: boolean;
    Dead: boolean;
    Pid: number;
    ExitCode: number;
    Error: string;
    StartedAt: string;
    FinishedAt: string;
  };
  Config: {
    Env: string[];
    Image: string;
  };
  HostConfig: {
    Binds: string[];
  };
}

export interface DockerResult {
  success: boolean;
  message: string;
  data?: any;
}

/**
 * Make a request to the Docker API via Unix socket
 */
async function dockerRequest(
  method: string,
  path: string,
  body?: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    // Check if Docker socket exists
    if (!fs.existsSync(DOCKER_SOCKET)) {
      reject(new Error('Docker socket not available at ' + DOCKER_SOCKET));
      return;
    }

    const options: http.RequestOptions = {
      socketPath: DOCKER_SOCKET,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        } else if (res.statusCode === 304) {
          // Not Modified - container already in desired state
          resolve({ notModified: true });
        } else {
          reject(new Error(`Docker API error: ${res.statusCode} - ${data}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * List all containers
 */
export async function listContainers(all: boolean = true): Promise<ContainerInfo[]> {
  return dockerRequest('GET', `/containers/json?all=${all}`);
}

/**
 * Get container by name
 */
export async function getContainerByName(name: string): Promise<ContainerInfo | null> {
  const containers = await listContainers();
  return containers.find(c => c.Names.some(n => n === `/${name}` || n === name)) || null;
}

/**
 * Inspect a container for detailed info
 */
export async function inspectContainer(containerId: string): Promise<ContainerInspect> {
  return dockerRequest('GET', `/containers/${containerId}/json`);
}

/**
 * Stop a container
 */
export async function stopContainer(containerId: string, timeout: number = 10): Promise<void> {
  await dockerRequest('POST', `/containers/${containerId}/stop?t=${timeout}`);
}

/**
 * Start a container
 */
export async function startContainer(containerId: string): Promise<void> {
  await dockerRequest('POST', `/containers/${containerId}/start`);
}

/**
 * Restart a container
 */
export async function restartContainer(containerId: string, timeout: number = 10): Promise<void> {
  await dockerRequest('POST', `/containers/${containerId}/restart?t=${timeout}`);
}

/**
 * Get container logs
 */
export async function getContainerLogs(
  containerId: string, 
  tail: number = 100
): Promise<string> {
  return dockerRequest('GET', `/containers/${containerId}/logs?stdout=true&stderr=true&tail=${tail}`);
}

/**
 * Kill a container (force stop)
 */
export async function killContainer(containerId: string): Promise<void> {
  await dockerRequest('POST', `/containers/${containerId}/kill`);
}

/**
 * Restart a container and wait for it to be running again
 * 
 * For the VPN container, this is sufficient to apply any settings changes
 * because the startup wrapper reads config from bind-mounted files.
 */
export async function restartContainerAndWait(
  containerName: string, 
  timeout: number = 30
): Promise<DockerResult> {
  try {
    console.log(`[Docker] Restarting container: ${containerName}`);
    
    // Find the container
    const container = await getContainerByName(containerName);
    if (!container) {
      return {
        success: false,
        message: `Container '${containerName}' not found`,
      };
    }

    // Restart the container
    console.log(`[Docker] Sending restart request for container: ${container.Id}`);
    await restartContainer(container.Id, timeout);

    // Wait for the container to be running again
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Check container status
    const newInfo = await inspectContainer(container.Id);
    
    if (newInfo.State.Running) {
      return {
        success: true,
        message: 'Container restarted successfully. VPN will reconnect with new settings shortly.',
        data: { containerId: container.Id, state: newInfo.State },
      };
    } else {
      return {
        success: false,
        message: `Container restart failed. Status: ${newInfo.State.Status}`,
        data: { containerId: container.Id, state: newInfo.State },
      };
    }
  } catch (error: any) {
    console.error('[Docker] Error restarting container:', error);
    return {
      success: false,
      message: `Failed to restart container: ${error.message}`,
    };
  }
}

/**
 * Restart the VPN container (pia-qbittorrent)
 * 
 * Uses Docker API to restart the container. The VPN container uses a startup
 * wrapper script that reads configuration from bind-mounted files:
 * - config/auth.conf: VPN credentials
 * - config/vpn.conf: VPN region and port forwarding settings
 * 
 * This means a simple restart is sufficient to apply any settings changes,
 * without needing complex docker-compose recreate operations.
 */
export async function restartVpnContainer(): Promise<DockerResult> {
  return restartContainerAndWait(CONTAINER_NAME, 30);
}

/**
 * Get VPN container status
 */
export async function getVpnContainerStatus(): Promise<DockerResult> {
  try {
    const container = await getContainerByName(CONTAINER_NAME);
    if (!container) {
      return {
        success: false,
        message: 'VPN container not found',
      };
    }

    const info = await inspectContainer(container.Id);
    return {
      success: true,
      message: info.State.Status,
      data: {
        running: info.State.Running,
        status: info.State.Status,
        startedAt: info.State.StartedAt,
      },
    };
  } catch (error: any) {
    return {
      success: false,
      message: `Failed to get container status: ${error.message}`,
    };
  }
}

/**
 * Check if Docker API is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return false;
    }
    await dockerRequest('GET', '/version');
    return true;
  } catch {
    return false;
  }
}

/**
 * List available .ovpn files from the VPN container.
 * Uses Docker exec API to run `ls /openvpn/nextgen/` inside the container.
 */
export async function listOvpnFiles(): Promise<string[]> {
  const container = await getContainerByName(CONTAINER_NAME);
  if (!container) {
    throw new Error('VPN container not found');
  }

  // Create exec instance
  const execCreate = await dockerRequest('POST', `/containers/${container.Id}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Cmd: ['ls', '/openvpn/nextgen/'],
  });

  // Start exec and read output
  const output: string = await new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath: DOCKER_SOCKET,
      path: `/exec/${execCreate.Id}/start`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk.toString(); });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(JSON.stringify({ Detach: false, Tty: false }));
    req.end();
  });

  // Parse filenames, filter to .ovpn files only
  return output
    .split(/[\n\r]+/)
    .map(f => f.replace(/[^\x20-\x7E]/g, '').trim())
    .filter(f => f.endsWith('.ovpn'));
}

export const dockerService = {
  listContainers,
  getContainerByName,
  inspectContainer,
  stopContainer,
  startContainer,
  restartContainer,
  killContainer,
  getContainerLogs,
  restartContainerAndWait,
  restartVpnContainer,
  getVpnContainerStatus,
  isDockerAvailable,
  listOvpnFiles,
};
