import * as github from "@actions/github";
import { HttpClient, HttpClientResponse } from "@actions/http-client";
import * as _ from "lodash";
import * as core from "@actions/core";
import { ConfigInterface } from "./config";

export class GithubClient {
  config: ConfigInterface;

  constructor(config: ConfigInterface) {
    this.config = config;
  }

  async getRunnerVersion(): Promise<string> {
    if (this.config.githubActionRunnerVersion)
      return this.config.githubActionRunnerVersion.replace("v", "");

    const httpClient = new HttpClient("http-client");
    const res: HttpClientResponse = await httpClient.get(
      "https://api.github.com/repos/actions/runner/releases/latest"
    );

    const body: string = await res.readBody();
    const obj = JSON.parse(body);
    // aztec: workaround random flake in this api seem in ci
    return (obj["tag_name"] || "v2.315.0").replace("v", "");
  }

  async getAllRunners() {
    const octokit = github.getOctokit(this.config.githubToken);
    try {
      let page = 1;
      const per_page = 100;
      let response = await octokit.rest.actions.listSelfHostedRunnersForRepo({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        per_page,
        page,
      });
      let allRunners = response.data.runners;
      let totalCount = response.data.total_count;

      while (allRunners.length < totalCount) {
        page++;
        response = await octokit.rest.actions.listSelfHostedRunnersForRepo({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          per_page,
          page,
        });
        totalCount = response.data.total_count;
        allRunners = allRunners.concat(response.data.runners);
      }

      return allRunners;
    } catch (error) {
      core.error(`Failed to list github runners: ${error}`);
      throw error;
    }
  }

  async getRunnersWithLabels(labels: string[]) {
    const searchLabels = {
      labels: labels.map(function (label) {
        return { name: label };
      }),
    };
    return _.filter(await this.getAllRunners(), searchLabels);
  }

  async getRunnerRegistrationToken() {
    const octokit = github.getOctokit(this.config.githubToken);
    try {
      const response =
        await octokit.rest.actions.createRegistrationTokenForRepo({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
        });

      return response.data;
    } catch (error) {
      core.error(`Failed to get Runner registration token: ${error}`);
      throw error;
    }
  }

  async removeRunnersWithLabels(labels: string[]) {
    let deletedAll = true;
    try {
      const runners = await this.getRunnersWithLabels(labels);
      console.log(
        "Found existing runners:",
        runners.map((r) => r.name)
      );
      const octokit = github.getOctokit(this.config.githubToken);
      for (const runner of runners) {
        const response =
          await octokit.rest.actions.deleteSelfHostedRunnerFromRepo({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            runner_id: runner.id,
          });
        deletedAll = deletedAll && response.status == 204;
      }
    } catch (error) {
      core.error(`Failed to delete runner: ${error}`);
    }
    return deletedAll;
  }

  async hasRunner(labels: string[]): Promise<boolean> {
    for (const runner of await this.getRunnersWithLabels(labels)) {
      if (runner.status === "online") {
        core.info(
          `GitHub self-hosted runner ${runner.name} with label ${labels} is ready to use. Continuing assuming other runners are online.`
        );
        return true;
      }
    }
    return false;
  }

  // Borrowed from https://github.com/machulav/ec2-github-runner/blob/main/src/aws.js
async pollForRunnerCreation(labels: string[]): Promise<void> {
  const { TIMEOUT_MINUTES, RETRY_INTERVAL, QUIET_PERIOD } = PAGINATION;
  
  core.info(`Waiting ${QUIET_PERIOD}s before polling for runners`);
  await new Promise(r => setTimeout(r, QUIET_PERIOD * 1000));
  
  return new Promise((resolve, reject) => {
    let waitSeconds = 0;
    const interval = setInterval(async () => {
      if (waitSeconds > TIMEOUT_MINUTES * 60) {
        clearInterval(interval);
        reject(`Timeout of ${TIMEOUT_MINUTES} minutes exceeded. Check EC2 internet access.`);
      }
      
      if (await this.hasRunner(labels)) {
        clearInterval(interval);
        resolve();
        return;
      }
      
      waitSeconds += RETRY_INTERVAL;
      core.info("Waiting for runners...");
    }, RETRY_INTERVAL * 1000);
  });
}
