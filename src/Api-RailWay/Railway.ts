import "dotenv/config";

const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const RAILWAY_GRAPHQL_ENDPOINT_APP = 'https://backboard.railway.app/graphql/v2';
const RAILWAY_PROJECT_ID = process.env.RAILWAY_PROJECT_ID;
const RAILWAY_ENVIRONMENT_ID = process.env.RAILWAY_ENVIRONMENT_ID
;
const RAILWAY_SERVICE_ID = process.env.RAILWAY_SERVICE_ID;
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;

if (!RAILWAY_PROJECT_ID || !RAILWAY_ENVIRONMENT_ID || !RAILWAY_SERVICE_ID || !RAILWAY_TOKEN) {
  throw new Error('Faltan variables de entorno RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID o RAILWAY_TOKEN');
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
  static async getActiveDeploymentId(): Promise<string | null> {
    const query = `
      query deployments($projectId: String!, $environmentId: String!, $serviceId: String!) {
        deployments(
          first: 1
          input: {
            projectId: "$projectId"
            environmentId: "$environmentId"
            serviceId: "$serviceId"
          }
        ) {
          edges {
            node {
              id
              staticUrl
            }
          }
        }
      }
    `;
    const variables = {
      projectId: RAILWAY_PROJECT_ID,
      environmentId: RAILWAY_ENVIRONMENT_ID,
      serviceId: RAILWAY_SERVICE_ID
    };
    const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT_APP, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${RAILWAY_TOKEN}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    const data: any = await res.json();
    if (!data?.data?.deployments?.edges?.length) {
      console.error('Respuesta inesperada de Railway API:', JSON.stringify(data, null, 2));
      return null;
    }
    return data.data.deployments.edges[0].node.id;
  }

  /**
   * Reinicia el deployment de Railway usando la API GraphQL
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  static async restartActiveDeployment(): Promise<{ success: boolean; error?: string }> {
    // Usar el deploymentId obtenido dinámicamente
    const deploymentId = await RailwayApi.getActiveDeploymentId();
    if (!deploymentId) {
      return { success: false, error: 'No se encontró deployment activo para el proyecto.' };
    }
    console.log('[RailwayApi] Usando deploymentId dinámico:', deploymentId);
    const mutation = {
      query: `mutation deploymentRestart($id: String!) { deploymentRestart(id: $id) }`,
      variables: { id: deploymentId }
    };
    try {
      const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${RAILWAY_TOKEN}`
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
