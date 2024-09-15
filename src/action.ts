/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import * as core from "@actions/core";
import { exec } from "@actions/exec";
import * as github from "@actions/github";

import { CommentController } from "./comment";
import * as input from "./inputs";
import { Inputs } from "./models";
import { setupTerraform } from "./setup-terraform";

const TRUNCATE_START =
  "Terraform used the selected providers to generate the following execution";
const TRUNCATE_END =
  "─────────────────────────────────────────────────────────────────────────────";

function hasTerraformChanges(output: string): Boolean {
  return !output.includes(
    "No changes. Your infrastructure matches the configuration."
  );
}

function getChangesFromOutput(output: string): string {
  let finalOutput = output;

  const truncateStart = output.indexOf(TRUNCATE_START);
  if (truncateStart > 0) {
    const truncateEnd = output.indexOf(TRUNCATE_END);
    finalOutput = output.substring(
      truncateStart,
      truncateEnd > 0 ? truncateEnd + TRUNCATE_END.length : output.length
    );
  }

  // Github max comment length is 65536, but we want to leave room for the rest of the comment content
  const maxOutputLength = 60000;
  if (finalOutput.length > maxOutputLength) {
    return `... Output truncated to the last ${maxOutputLength} characters ...\n\n${finalOutput.substring(
      finalOutput.length - maxOutputLength
    )}`;
  }
  return finalOutput;
}

function postComment(
  commentController: CommentController,
  title: string,
  runUrl: String | undefined,
  output: string | undefined,
  outputTitle: Error | string
): Promise<void> {
  const changes = output ? getChangesFromOutput(output) : undefined;
  core.debug(`changes?.length: ${changes?.length}`);
  core.debug(`output?.length: ${output?.length}`);
  core.setOutput("output", output);
  core.setOutput("changes", changes);

  return commentController.postCommentOnPr(
    `### ${title}

${runUrl ? `<a target="_blank" href='${runUrl}'>🌍 View run</a>` : ""}

${
  !!changes
    ? `<details><summary>${outputTitle}</summary>

\`\`\`shell
${changes}
\`\`\`

</details>`
    : ""
}`
  );
}

function getRunUrl(output: string): string | undefined {
  const runUrlIdentifier = "Created speculative Terraform Cloud run:";
  const runUrl = output
    .split("\n")
    .find((line) => line.includes(runUrlIdentifier));

  if (!runUrl) {
    return undefined;
  }

  const urlStart = runUrl.indexOf("http");
  return runUrl.substring(urlStart);
}

enum ExecutionMode {
  SynthOnly = "synth-only",
  PlanOnly = "plan-only",
  AutoApproveApply = "auto-approve-apply",
  AutoApproveDestroy = "auto-approve-destroy",
}

async function execute(
  cdktfCommand: string,
  inputs: Inputs,
  reportSuccess: (output: string, runUrl?: string) => Promise<void>,
  reportFailure: (
    error: Error,
    output: string,
    runUrl?: string
  ) => Promise<void>
): Promise<void> {
  core.debug(`Installing terraform`);
  await setupTerraform(inputs.terraformVersion);

  const mainCommand = `${cdktfCommand} ${inputs.cdktfArgs}`;
  const fullCdktfCommand = inputs.customNpxArgs
    ? `npx --yes ${inputs.customNpxArgs} cdktf-cli@${inputs.cdktfVersion} ${mainCommand}`
    : `npx --yes cdktf-cli@${inputs.cdktfVersion} ${mainCommand}`;

  core.debug(`Executing: ${fullCdktfCommand}`);
  let output = "";
  try {
    await exec(fullCdktfCommand, [], {
      cwd: inputs.workingDirectory || process.cwd(),
      env: {
        ...process.env,
        FORCE_COLOR: "0", // disable chalk terminal colors
        TF_CLI_ARGS: "-no-color", // disable terraform colors
        TF_TOKEN_app_terraform_io: inputs.terraformCloudToken, // set the terraform cloud token if present
      },
      listeners: {
        stderr: (data) => {
          const str = data.toString();
          output += str;
          core.warning(str);
        },
        stdout: (data) => {
          const str = data.toString();
          output += str;
        },
      },
    });
  } catch (error) {
    core.debug(`Output: ${output}`);
    await reportFailure(error as Error, output, getRunUrl(output));
    throw error;
  }

  await reportSuccess(output, getRunUrl(output));
  core.debug(`Finished executing`);
}

export async function run(): Promise<void> {
  const inputs: Inputs = {
    cdktfVersion: input.cdktfVersion,
    terraformVersion: input.terraformVersion,
    workingDirectory: input.workingDirectory,
    stackName: input.stackName,
    mode: input.mode,
    terraformCloudToken: input.terraformCloudToken,
    githubToken: input.githubToken,
    commentOnPr: input.commentOnPr,
    updateComment: input.updateComment,
    customNpxArgs: input.customNpxArgs,
    cdktfArgs: input.cdktfArgs,
  };
  const octokit = github.getOctokit(inputs.githubToken);
  const commentController = new CommentController({
    inputs,
    octokit,
    context: github.context,
  });
  core.debug(
    `Starting action with context: ${JSON.stringify(github.context, null, 2)}`
  );

  core.debug(`Running action in '${inputs.mode}' mode`);
  switch (inputs.mode) {
    case ExecutionMode.SynthOnly:
      await execute(
        `synth`,
        inputs,
        () =>
          postComment(
            commentController,
            `✅ Successfully synthesized the Terraform CDK Application`,
            undefined,
            undefined,
            ""
          ),
        (error, output) =>
          postComment(
            commentController,
            "❌ Error synthesizing the Terraform CDK Application",
            undefined,
            output,
            error
          )
      );
      break;

    case ExecutionMode.PlanOnly:
      if (!inputs.stackName) {
        throw new Error(
          `Stack name must be provided when running in 'plan-only' mode`
        );
      }
      await execute(
        `plan ${inputs.stackName}`,
        inputs,
        (output, runUrl) =>
          hasTerraformChanges(output)
            ? postComment(
                commentController,
                `✅ Successfully planned Terraform CDK Stack '${inputs.stackName}'`,
                runUrl,
                output,
                "Show Plan"
              )
            : postComment(
                commentController,
                `🟰 No changes in Terraform CDK Stack '${inputs.stackName}'`,
                runUrl,
                output,
                "Show Plan"
              ),
        (error, output, runUrl) =>
          postComment(
            commentController,
            `❌ Error planning Terraform CDK Stack '${inputs.stackName}'`,
            runUrl,
            output,
            error
          )
      );
      break;

    case ExecutionMode.AutoApproveApply:
      if (!inputs.stackName) {
        throw new Error(
          `Stack name must be provided when running in 'auto-approve-apply' mode`
        );
      }
      await execute(
        `apply ${inputs.stackName} --auto-approve`,
        inputs,
        (output, runUrl) =>
          hasTerraformChanges(output)
            ? postComment(
                commentController,
                `✅ Successfully applied Terraform CDK Stack '${inputs.stackName}'`,
                runUrl,
                output,
                "Show Run"
              )
            : postComment(
                commentController,
                `🟰 No changes to apply in Terraform CDK Stack '${inputs.stackName}'`,
                runUrl,
                output,
                "Show Run"
              ),
        (error, output, runUrl) =>
          postComment(
            commentController,
            `❌ Error applying Terraform CDK Stack '${inputs.stackName}'`,
            runUrl,
            output,
            error
          )
      );
      break;

    case ExecutionMode.AutoApproveDestroy:
      if (!inputs.stackName) {
        throw new Error(
          `Stack name must be provided when running in 'auto-approve-destroy' mode`
        );
      }
      await execute(
        `destroy ${inputs.stackName} --auto-approve`,
        inputs,
        () =>
          postComment(
            commentController,
            `✅ Successfully destroyed the Terraform CDK Application '${inputs.stackName}'`,
            undefined,
            undefined,
            ""
          ),
        (error, output) =>
          postComment(
            commentController,
            `❌ Error destroying the Terraform CDK Application '${inputs.stackName}'`,
            undefined,
            output,
            error
          )
      );
      break;

    default:
      throw new Error(
        `Invalid mode passed: '${inputs.mode}', needs to be one of '${ExecutionMode.SynthOnly}', '${ExecutionMode.PlanOnly}', '${ExecutionMode.AutoApproveApply}', '${ExecutionMode.AutoApproveDestroy}'`
      );
  }
}
