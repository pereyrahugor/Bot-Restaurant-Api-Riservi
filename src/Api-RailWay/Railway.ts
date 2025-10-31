


const RAILWAY_GRAPHQL_ENDPOINT = 'https://backboard.railway.com/graphql/v2';
const deploymentRailWayId = process.env.deploymentRailWayId;
const tokenRailWayTeam = process.env.tokenRailWayTeam;

if (!deploymentRailWayId || !tokenRailWayTeam) {
	throw new Error('Faltan variables de entorno deploymentRailWayId o tokenRailWayTeam');
}

/**
 * Reinicia el deployment de Railway usando la API GraphQL
 * @returns {Promise<{success: boolean, error?: string}>}
 */

export async function restartRailwayDeployment() {
	// El id debe ir entre comillas en el mutation GraphQL
	const mutation = {
		query: `mutation deploymentRestart { deploymentRestart(id: \"${deploymentRailWayId}\") }`
	};
		try {
			const res = await fetch(RAILWAY_GRAPHQL_ENDPOINT, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${tokenRailWayTeam}`
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
