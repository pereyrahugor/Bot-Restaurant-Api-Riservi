import "dotenv/config";

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_GRAPHQL_ENDPOINT_APP = 'https://backboard.railway.app/graphql/v2';
const projectRailWayId = process.env.projectRailWayId;
const projectRailWayToken = process.env.RAILWAY_TOKEN;

if (!projectRailWayId || !projectRailWayToken) {
  throw new Error('Faltan variables de entorno projectRailWayId o projectRailWayToken');
}

interface DeploymentNode {
  id: string;
  status: string;
  createdAt: string;
}

interface DeploymentResponse {
  data: {
    deployments: {
      edges: Array<{ node: DeploymentNode }>;
    };
  };
}

export class RailwayApi {
  static async getActiveDeploymentId(projectId: string, projectToken: string): Promise<string | null> {
    const query = `
      query getDeployments($projectId: String!) {
        deployments(projectId: $projectId) {
          edges {
            node {
              id
              status
              createdAt
            }
          }
        }
      }
    `;
    const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT_APP, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Project-Access-Token': projectToken,
      },
      body: JSON.stringify({ query, variables: { projectId } }),
    });
    const data: any = await res.json();
    if (!data?.data?.deployments?.edges) {
      console.error('Respuesta inesperada de Railway API:', JSON.stringify(data, null, 2));
      return null;
    }
    const deployments = data.data.deployments.edges.map((e: any) => e.node);
    const active = deployments
      .filter((d: any) => d.status === 'SUCCESS')
      .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return active?.id || null;
  }

  /**
   * Reinicia el deployment de Railway usando la API GraphQL
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  static async restartActiveDeployment(): Promise<{ success: boolean; error?: string }> {
    const deploymentId = await RailwayApi.getActiveDeploymentId(projectRailWayId, projectRailWayToken);
    if (!deploymentId) {
      return { success: false, error: 'No se encontró deployment activo para el proyecto.' };
    }
    const mutation = {
      query: `mutation deploymentRestart { deploymentRestart(id: "${deploymentId}") }`
    };
    try {
      const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Project-Access-Token': projectRailWayToken
        },
        body: JSON.stringify(mutation)
      });
      const data = await res.json();
      if (data.errors) {
        return { success: false, error: data.errors.map((e: any) => e.message).join('; ') };
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
