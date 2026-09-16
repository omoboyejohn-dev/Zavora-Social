const transaction =
    await itemRef.transaction(
        (currentValue) => {

            if (
                currentValue === null ||
                currentValue === undefined
            ) {

                return;

            }

            if (
                !isAvailable(
                    currentValue
                )
            ) {

                return;

            }

            return {

                ...currentValue,

                status:
                    "processing",

                processingBy:
                    uid,

                processingAt:
                    Date.now()

            };

        }
    );
